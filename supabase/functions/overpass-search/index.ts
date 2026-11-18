const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

type SourceStatus = {
  name: string;
  url: string;
  status: "connected" | "unavailable" | "rate_limited" | "not_configured";
  lastQuery: string | null;
  responseTime: number | null;
  lastError: string | null;
  resultCount: number | null;
};

const sources: { name: string; url: string }[] = [
  { name: "Overpass API (principal)", url: "https://overpass-api.de/api/interpreter" },
  { name: "Kumi Systems (alternativa 1)", url: "https://overpass.kumi.systems/api/interpreter" },
  { name: "Private Coffee (alternativa 2)", url: "https://overpass.private.coffee/api/interpreter" },
  { name: "Mail.ru (alternativa 3)", url: "https://maps.mail.ru/osm/tools/overpass/api/interpreter" },
];

const cityAliases: Record<string, string> = {
  "Jundiaí": "Jundiaí",
  "Várzea Paulista": "Várzea Paulista",
  "Campo Limpo Paulista": "Campo Limpo Paulista",
  Itupeva: "Itupeva",
  Louveira: "Louveira",
  Jarinu: "Jarinu",
  Cabreúva: "Cabreúva",
  Itatiba: "Itatiba",
  Campinas: "Campinas",
};

const segmentFilters: Record<string, string> = {
  Indústrias: `nwr["industrial"](area.searchArea);nwr["landuse"="industrial"](area.searchArea);nwr["craft"](area.searchArea);nwr["office"](area.searchArea);`,
  Supermercados: `nwr["shop"="supermarket"](area.searchArea);nwr["shop"="hypermarket"](area.searchArea);`,
  "Postos de combustível": `nwr["amenity"="fuel"](area.searchArea);`,
  Restaurantes: `nwr["amenity"="restaurant"](area.searchArea);nwr["amenity"="fast_food"](area.searchArea);`,
  "Empresas alimentícias": `nwr["industrial"](area.searchArea);nwr["craft"="food"](area.searchArea);nwr["shop"="bakery"](area.searchArea);`,
  Transportadoras: `nwr["office"="logistics"](area.searchArea);nwr["office"="transport"](area.searchArea);nwr["industrial"](area.searchArea);`,
  "Centros logísticos": `nwr["warehouse"](area.searchArea);nwr["building"="warehouse"](area.searchArea);nwr["landuse"="industrial"](area.searchArea);`,
  Condomínios: `nwr["building"="apartments"](area.searchArea);nwr["landuse"="residential"](area.searchArea);`,
  Hospitais: `nwr["amenity"="hospital"](area.searchArea);nwr["healthcare"="hospital"](area.searchArea);`,
  Clínicas: `nwr["amenity"="clinic"](area.searchArea);nwr["healthcare"="clinic"](area.searchArea);`,
  "Construção civil": `nwr["craft"="builder"](area.searchArea);nwr["office"="construction"](area.searchArea);`,
  "Empresas de manutenção": `nwr["craft"](area.searchArea);nwr["office"](area.searchArea);`,
  "Centros comerciais": `nwr["shop"="mall"](area.searchArea);nwr["shop"="department_store"](area.searchArea);`,
};

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildQuery(cities: string[], segment: string, name: string): string {
  const cityClauses = cities.map((city) => {
    const safeCity = escapeRegex(cityAliases[city] ?? city);
    const filters = segmentFilters[segment] ?? `nwr["shop"](area.searchArea);nwr["office"](area.searchArea);nwr["amenity"](area.searchArea);nwr["industrial"](area.searchArea);nwr["craft"](area.searchArea);nwr["healthcare"](area.searchArea);nwr["tourism"](area.searchArea);nwr["warehouse"](area.searchArea);nwr["landuse"](area.searchArea);`;
    const nameFilter = name.trim() ? `["name"~"${escapeRegex(name.trim())}",i]` : "";
    return `area["name"~"^${safeCity}$",i]["boundary"="administrative"]["admin_level"="8"]->.searchArea;(${filters.replaceAll("(area.searchArea)", `${nameFilter}(area.searchArea)`)});`;
  }).join("");
  return `[out:json][timeout:25];${cityClauses}out center 80;`;
}

async function querySource(url: string, query: string, timeoutMs: number): Promise<{ ok: boolean; status: number; data?: { elements?: unknown[] }; error?: string; responseTime: number }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json", "User-Agent": "JundAmbientalProspect/2.0 (https://jundambiental.com.br)" },
      body: `data=${encodeURIComponent(query)}`,
      signal: controller.signal,
    });
    const responseTime = Date.now() - t0;
    clearTimeout(timeout);
    if (response.status === 429) {
      const retryAfter = response.headers.get("Retry-After");
      return { ok: false, status: 429, error: `Limite de requisições atingido (429). ${retryAfter ? `Aguardar ${retryAfter}s.` : ""}`, responseTime };
    }
    if (!response.ok) return { ok: false, status: response.status, error: `HTTP ${response.status}`, responseTime };
    const data = await response.json() as { elements?: unknown[] };
    if (!Array.isArray(data.elements)) return { ok: false, status: 200, error: "Resposta sem elementos válidos", responseTime };
    return { ok: true, status: 200, data, responseTime };
  } catch (error) {
    clearTimeout(timeout);
    const responseTime = Date.now() - t0;
    const message = error instanceof Error ? (error.name === "AbortError" ? "Timeout" : error.message) : "Erro desconhecido";
    return { ok: false, status: 0, error: message, responseTime };
  }
}

async function searchWithFailover(cities: string[], segment: string, name: string, limit: number): Promise<{ elements: unknown[]; source: string; diagnostics: SourceStatus[] }> {
  const query = buildQuery(cities, segment, name);
  const diagnostics: SourceStatus[] = [];
  const timestamp = new Date().toISOString();
  for (const source of sources) {
    const result = await querySource(source.url, query, 18000);
    const status: SourceStatus = {
      name: source.name,
      url: source.url,
      status: result.ok ? "connected" : result.status === 429 ? "rate_limited" : "unavailable",
      lastQuery: timestamp,
      responseTime: result.responseTime,
      lastError: result.error ?? null,
      resultCount: result.ok && result.data?.elements ? result.data.elements.length : null,
    };
    diagnostics.push(status);
    if (result.ok && result.data?.elements && result.data.elements.length > 0) {
      return { elements: result.data.elements.slice(0, limit), source: source.name, diagnostics };
    }
  }
  return { elements: [], source: "", diagnostics };
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  try {
    if (request.method === "GET") {
      const pingQuery = '[out:json][timeout:8];out 1;';
      const pingResults: SourceStatus[] = [];
      for (const source of sources) {
        const result = await querySource(source.url, pingQuery, 6000);
        pingResults.push({
          name: source.name,
          url: source.url,
          status: result.ok ? "connected" : result.status === 429 ? "rate_limited" : "unavailable",
          lastQuery: new Date().toISOString(),
          responseTime: result.responseTime,
          lastError: result.error ?? null,
          resultCount: null,
        });
      }
      return new Response(JSON.stringify({ diagnostics: pingResults }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    if (request.method !== "POST") return new Response(JSON.stringify({ error: "Use POST para pesquisar ou GET para diagnóstico." }), { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    const body = await request.json() as { cities?: string[]; segment?: string; name?: string; limit?: number };
    const cities = Array.isArray(body.cities) ? body.cities.filter((city): city is string => typeof city === "string" && city.length > 0).slice(0, 5) : [];
    const segment = typeof body.segment === "string" ? body.segment : "";
    const name = typeof body.name === "string" ? body.name.slice(0, 80) : "";
    const limit = Math.min(Math.max(Number(body.limit) || 80, 1), 100);
    if (!cities.length) return new Response(JSON.stringify({ error: "Selecione ao menos uma cidade." }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    const { elements, source, diagnostics } = await searchWithFailover(cities, segment, name, limit);
    if (elements.length === 0) {
      const allErrors = diagnostics.map(d => `${d.name}: ${d.lastError || "sem resposta"}`).join("; ");
      return new Response(JSON.stringify({ error: `Todas as fontes estão indisponíveis. ${allErrors}`, elements: [], diagnostics }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ elements, source, query: { cities, segment, name }, diagnostics }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erro desconhecido";
    return new Response(JSON.stringify({ error: `Erro interno: ${message}` }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
