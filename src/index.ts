import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import axios, { AxiosInstance, AxiosError } from "axios";
import http from "node:http";
import crypto from "node:crypto";

// ── Configuration ─────────────────────────────────────────────────────────────
const MAKE_API_KEY = process.env.MAKE_API_KEY ?? "";
const MAKE_TEAM_ID = process.env.MAKE_TEAM_ID ?? "";
const MAKE_REGION = process.env.MAKE_REGION ?? "eu1";

if (!MAKE_API_KEY) {
  process.stderr.write("[make-mcp] AVISO: MAKE_API_KEY não configurada — todas as chamadas falharão com 401\n");
}

const apiCache = new Map<string, AxiosInstance>();

function getApi(region?: string): AxiosInstance {
  const r = region ?? MAKE_REGION;
  if (!apiCache.has(r)) {
    const instance = axios.create({
      baseURL: `https://${r}.make.com/api/v2`,
      timeout: 30000,
    });
    // Inject token dynamically on every request so env var changes are picked up
    // and instances created before the var was set still work correctly.
    instance.interceptors.request.use((config) => {
      const key = process.env.MAKE_API_KEY ?? MAKE_API_KEY;
      config.headers.Authorization = `Token ${key}`;
      return config;
    });
    apiCache.set(r, instance);
  }
  return apiCache.get(r)!;
}

function teamId(override?: string): string {
  return override ?? MAKE_TEAM_ID;
}

// ── Region auto-discovery ──────────────────────────────────────────────────────
// Caches team_id → region so every tool uses the correct zone automatically,
// even when the configured MAKE_REGION differs from the team's actual zone.
const teamRegionCache = new Map<string, string>();
const teamNameCache = new Map<string, string>(); // team_id → name
let regionCacheBuilt = false;
let regionCachePending: Promise<void> | null = null;

// Ordered list of regions to probe when the configured one fails.
// The configured MAKE_REGION is always tried first via getOrgsFromAnyRegion.
const FALLBACK_REGIONS = ["us1", "us2", "eu1", "eu2"];

// ── Fuzzy matching ────────────────────────────────────────────────────────────
function normalizeName(s: string): string {
  return s.toLowerCase().trim().normalize("NFD").replace(/\p{Mn}/gu, "");
}

function similarity(a: string, b: string): number {
  const tokensA = new Set(normalizeName(a).split(/\s+/).filter(Boolean));
  const tokensB = new Set(normalizeName(b).split(/\s+/).filter(Boolean));
  const union = new Set([...tokensA, ...tokensB]);
  if (union.size === 0) return 0;
  let intersection = 0;
  for (const t of tokensA) if (tokensB.has(t)) intersection++;
  return intersection / union.size;
}

/**
 * Busca /organizations tentando regiões em ordem até encontrar uma que funcione.
 * Retorna [orgs, regiãoUsada]. Lança erro se nenhuma funcionar.
 */
async function getOrgsFromAnyRegion(preferredRegion?: string): Promise<[Array<{ id: number; name: string; zone: string }>, string]> {
  const key = process.env.MAKE_API_KEY ?? MAKE_API_KEY;
  const ordered = [
    preferredRegion ?? MAKE_REGION,
    ...FALLBACK_REGIONS.filter((r) => r !== (preferredRegion ?? MAKE_REGION)),
  ];
  for (const r of ordered) {
    try {
      const resp = await getApi(r).get("/organizations", { headers: { Authorization: `Token ${key}` } });
      const orgs: Array<{ id: number; name: string; zone: string }> = resp.data?.organizations ?? [];
      if (orgs.length > 0) return [orgs, r];
    } catch { /* tenta próxima região */ }
  }
  throw new Error("Nenhuma região respondeu com organizações. Verifique a MAKE_API_KEY.");
}

async function buildRegionCache(): Promise<void> {
  if (regionCacheBuilt) return;
  if (regionCachePending) return regionCachePending;

  regionCachePending = (async () => {
    try {
      const [orgs] = await getOrgsFromAnyRegion();

      await Promise.allSettled(
        orgs.map(async (org) => {
          const zone = org.zone; // e.g. "eu2.make.com"
          const regionPart = zone.split(".")[0]; // "eu2"
          try {
            const teamsResp = await axios.get(`https://${zone}/api/v2/teams`, {
              headers: { Authorization: `Token ${process.env.MAKE_API_KEY ?? MAKE_API_KEY}` },
              params: { organizationId: org.id },
              timeout: 30000,
            });
            const teams: Array<{ id: number; name: string }> = teamsResp.data?.teams ?? [];
            for (const team of teams) {
              teamRegionCache.set(String(team.id), regionPart);
              teamNameCache.set(String(team.id), team.name);
            }
          } catch { /* skip orgs onde o fetch de times falhar */ }
        })
      );
      regionCacheBuilt = true;
    } catch { /* se /organizations falhar em todas as regiões, cache fica vazio — fallback para MAKE_REGION */ }
    regionCachePending = null;
  })();

  return regionCachePending;
}

/**
 * Resolve a região correta para uma chamada.
 * Prioridade: hint explícito > cache de team_id > descoberta automática > MAKE_REGION
 */
async function resolveRegion(team_id?: string, hint?: string): Promise<string> {
  if (hint) return hint;
  const tid = team_id ?? MAKE_TEAM_ID;
  if (!tid) return MAKE_REGION;
  if (teamRegionCache.has(tid)) return teamRegionCache.get(tid)!;
  await buildRegionCache();
  return teamRegionCache.get(tid) ?? MAKE_REGION;
}

/**
 * Resolve um time pelo nome ou ID numérico.
 * - ID numérico → resolve a região via cache.
 * - Nome → fuzzy match contra todos os times conhecidos (buildRegionCache).
 * - Se ambíguo → lança erro listando os candidatos.
 * - regionHint → sobrescreve a região resolvida (para compatibilidade com o param region explícito).
 */
async function resolveTeam(input?: string, regionHint?: string): Promise<{ team_id: string; region: string }> {
  const raw = input ?? MAKE_TEAM_ID;

  // Numeric ID or empty → use existing region resolution
  if (!raw || /^\d+$/.test(raw)) {
    const region = regionHint ?? (await resolveRegion(raw || undefined));
    return { team_id: raw, region };
  }

  // Name-based resolution
  await buildRegionCache();

  interface TeamMatch { team_id: string; name: string; region: string; score: number }
  const matches: TeamMatch[] = [];
  for (const [tid, name] of teamNameCache.entries()) {
    const score = similarity(raw, name);
    if (score > 0.3) {
      matches.push({ team_id: tid, name, region: teamRegionCache.get(tid) ?? MAKE_REGION, score });
    }
  }
  matches.sort((a, b) => b.score - a.score);

  if (matches.length === 0) {
    throw new Error(`Nenhum time encontrado com nome similar a "${raw}". Use list_all_teams para ver os disponíveis.`);
  }

  const top = matches[0];
  const second = matches[1];
  if (top.score >= 0.7 && (!second || top.score > second.score + 0.15)) {
    return { team_id: top.team_id, region: regionHint ?? top.region };
  }

  const candidates = matches.slice(0, 4)
    .map(m => `"${m.name}" (team_id: ${m.team_id})`)
    .join(", ");
  throw new Error(`Nome ambíguo "${raw}". Candidatos: ${candidates}. Passe o team_id numérico diretamente.`);
}

// ── Expert context ─────────────────────────────────────────────────────────────
const MAKE_EXPERT_CONTEXT =
  "Especialista em Make.com. Referência técnica:\n" +
  "ARQUITETURA: cenários processam bundles entre módulos. Tipos: trigger, action, search, aggregator, iterator, router.\n" +
  "MAPEAMENTO: expressões {{N.field}} referenciam output do módulo N. Funções: formatDate(), toString(), parseNumber(), if().\n" +
  "BOAS PRÁTICAS: Error Handler em módulos HTTP, max 20 módulos por cenário, webhooks respondem imediatamente, Data Stores para estado entre execuções.\n" +
  "LIMITAÇÕES: timeout 40min (básico: 2min), HTTP máx 10MB, webhooks têm fila.\n" +
  "BLUEPRINT: flow[] contém módulos com id, module, mapper, metadata. Routers têm routes[]. Connections referenciadas por ID.";

// ── Status map ────────────────────────────────────────────────────────────────
const STATUS_MAP: Record<number, string> = { 1: "success", 2: "warning", 3: "error" };

function normalizeStatus(status: unknown): string {
  if (typeof status === "number") return STATUS_MAP[status] ?? String(status);
  return String(status ?? "unknown");
}

// ── Types ─────────────────────────────────────────────────────────────────────
interface MakeScenario {
  id: number;
  name: string;
  isActive: boolean;
  lastExecution?: string;
  executionsCount?: number;
  scheduling?: { type: string; interval?: number };
}

interface MakeLog {
  executionId?: string;
  id?: string;
  status: string | number;
  timestamp?: string;
  startedAt?: string;
  duration?: number;
  operations?: number;
  error?: { message?: string };
}

interface BlueprintModule {
  id: number;
  module: string;
  metadata?: { designer?: { name?: string } };
}

// ── Error helper ──────────────────────────────────────────────────────────────
function makeErrorMessage(err: unknown, toolName: string): string {
  if (err instanceof AxiosError) {
    const msg =
      (err.response?.data as Record<string, unknown>)?.message ??
      err.message;
    return `Erro em ${toolName}: ${msg}`;
  }
  return `Erro em ${toolName}: ${String(err)}`;
}

// ── Group 1: Read ─────────────────────────────────────────────────────────────

async function listScenarios(active_only?: boolean, team_id?: string, region?: string) {
  const { team_id: resolvedTeamId, region: resolvedRegion } = await resolveTeam(team_id, region);
  const resp = await getApi(resolvedRegion).get("/scenarios", {
    params: { teamId: resolvedTeamId, islinked: true },
  });
  let scenarios: MakeScenario[] = resp.data?.scenarios ?? [];
  if (active_only) scenarios = scenarios.filter((s) => s.isActive);
  return scenarios.map((s) => ({
    id: s.id,
    name: s.name,
    team_id: resolvedTeamId,
    active: s.isActive,
    last_run: s.lastExecution ?? null,
    runs_count: s.executionsCount ?? 0,
    next_run: s.scheduling ?? null,
  }));
}

async function getScenario(scenario_id: number, region?: string) {
  const resolvedRegion = await resolveRegion(undefined, region);
  const [scenarioResp, blueprintResp] = await Promise.all([
    getApi(resolvedRegion).get(`/scenarios/${scenario_id}`),
    getApi(resolvedRegion).get(`/scenarios/${scenario_id}/blueprint`),
  ]);

  const s: MakeScenario = scenarioResp.data?.scenario ?? scenarioResp.data;
  const blueprint = blueprintResp.data?.response?.blueprint ?? blueprintResp.data?.blueprint ?? blueprintResp.data;

  const flow: BlueprintModule[] = blueprint?.flow ?? [];
  const modules = flow.map((item) => ({
    id: item.id,
    module_type: item.module,
    label: item.metadata?.designer?.name ?? `módulo ${item.id}`,
  }));

  return {
    id: s.id,
    name: s.name,
    active: s.isActive,
    scheduling: s.scheduling ?? null,
    modules_count: modules.length,
    modules,
    blueprint,
  };
}

async function listConnections(team_id?: string, region?: string) {
  const { team_id: resolvedTeamId, region: resolvedRegion } = await resolveTeam(team_id, region);
  const resp = await getApi(resolvedRegion).get("/connections", {
    params: { teamId: resolvedTeamId },
  });
  const connections: Array<{
    id: number;
    name: string;
    accountType?: string;
    isValid?: boolean;
  }> = resp.data?.connections ?? [];
  return connections.map((c) => ({
    id: c.id,
    name: c.name,
    app: c.accountType ?? null,
    valid: c.isValid ?? null,
  }));
}

async function listWebhooks(team_id?: string, region?: string) {
  const { team_id: resolvedTeamId, region: resolvedRegion } = await resolveTeam(team_id, region);
  const resp = await getApi(resolvedRegion).get("/hooks", {
    params: { teamId: resolvedTeamId },
  });
  const hooks: Array<{
    id: number;
    name: string;
    url?: string;
    scenarioId?: number;
    scenarioName?: string;
    isActive?: boolean;
  }> = resp.data?.hooks ?? [];
  return hooks.map((h) => ({
    id: h.id,
    name: h.name,
    url: h.url ?? null,
    scenario_id: h.scenarioId ?? null,
    scenario_name: h.scenarioName ?? null,
    active: h.isActive ?? null,
  }));
}

// ── Group 2: Write ────────────────────────────────────────────────────────────

async function createScenario(
  name: string,
  blueprint: object,
  team_id?: string,
  region?: string
) {
  const { team_id: resolvedTeamId, region: resolvedRegion } = await resolveTeam(team_id, region);
  const resp = await getApi(resolvedRegion).post("/scenarios", {
    teamId: resolvedTeamId,
    blueprint: JSON.stringify(blueprint),
    scheduling: { type: "indefinitely", interval: 900 },
  });
  const s = resp.data?.scenario ?? resp.data;
  return { id: s.id, name: s.name, created: true };
}

async function updateScenario(scenario_id: number, blueprint: object, region?: string) {
  const resolvedRegion = await resolveRegion(undefined, region);
  await getApi(resolvedRegion).patch(`/scenarios/${scenario_id}`, {
    blueprint: JSON.stringify(blueprint),
  });
  return { scenario_id, updated: true };
}

async function cloneScenario(
  scenario_id: number,
  new_name: string,
  team_id?: string,
  region?: string
) {
  const { team_id: resolvedTeamId, region: resolvedRegion } = await resolveTeam(team_id, region);
  const resp = await getApi(resolvedRegion).post(`/scenarios/${scenario_id}/clone`, {
    teamId: resolvedTeamId,
    name: new_name,
  });
  const s = resp.data?.scenario ?? resp.data;
  return { original_id: scenario_id, new_id: s.id, name: s.name };
}

async function toggleScenario(scenario_id: number, active: boolean, region?: string) {
  const resolvedRegion = await resolveRegion(undefined, region);
  await getApi(resolvedRegion).patch(`/scenarios/${scenario_id}`, { isActive: active });
  return { scenario_id, active };
}

// ── Group 3: Schema & Smart Creation ─────────────────────────────────────────

async function getAppModules(app_name: string, region?: string) {
  const resolvedRegion = await resolveRegion(undefined, region);
  const resp = await getApi(resolvedRegion).get(`/apps/${app_name}/modules`);
  const modules: Array<{
    name: string;
    label?: string;
    typeLabel?: string;
    description?: string;
  }> = resp.data?.modules ?? resp.data ?? [];
  return {
    modules: modules.map((m) => ({
      name: m.name,
      label: m.label ?? null,
      type_label: m.typeLabel ?? null,
      description: m.description ?? null,
    })),
    note: "Use get_module_schema para ver os campos de cada módulo",
  };
}

async function getModuleSchema(app_name: string, module_name: string, region?: string) {
  const resolvedRegion = await resolveRegion(undefined, region);
  const resp = await getApi(resolvedRegion).get(`/apps/${app_name}/modules/${module_name}`);
  return { schema: resp.data };
}

async function getWebhookPayload(scenario_id: number, region?: string) {
  const resolvedRegion = await resolveRegion(undefined, region);
  const logsResp = await getApi(resolvedRegion).get(`/scenarios/${scenario_id}/logs`, {
    params: { "pg[limit]": 10 },
  });

  const logs: MakeLog[] = logsResp.data?.scenarioLogs ?? logsResp.data?.scenarioExecutions ?? logsResp.data?.logs ?? [];
  const successLog = logs.find((l) => normalizeStatus(l.status) === "success");

  if (!successLog) {
    return {
      found: false,
      message:
        "Nenhuma execução bem-sucedida encontrada. Cole um exemplo do payload JSON na conversa para continuar.",
    };
  }

  const execId = successLog.executionId ?? successLog.id ?? "";
  const detailResp = await getApi(resolvedRegion).get(`/scenarios/${scenario_id}/logs/${execId}`);
  const detail = detailResp.data;

  const firstModuleOutput =
    detail?.modules?.[0]?.outputBundle ??
    detail?.modules?.[0]?.output ??
    {};

  const variables = Object.entries(
    typeof firstModuleOutput === "object" && firstModuleOutput !== null
      ? (firstModuleOutput as Record<string, unknown>)
      : {}
  ).map(([field, value]) => ({
    field,
    make_expression: `{{1.${field}}}`,
    example_value: value,
  }));

  return { found: true, payload: firstModuleOutput, variables };
}

// ── Group 4: Diagnostics ──────────────────────────────────────────────────────

async function getExecutionLogs(scenario_id: number, limit = 10, region?: string, status_filter?: string) {
  const resolvedRegion = await resolveRegion(undefined, region);
  const resp = await getApi(resolvedRegion).get(`/scenarios/${scenario_id}/logs`, {
    params: { "pg[limit]": limit },
  });
  const logs: MakeLog[] =
    resp.data?.scenarioLogs ?? resp.data?.scenarioExecutions ?? resp.data?.logs ?? [];
  const mapped = logs.map((l) => ({
    id: l.executionId ?? l.id ?? null,
    scenario_id,
    status: normalizeStatus(l.status),
    started: l.timestamp ?? l.startedAt ?? null,
    duration_ms: l.duration ?? null,
    operations: l.operations ?? null,
    error: l.error?.message ?? null,
  }));
  if (status_filter) {
    const sf = status_filter.toLowerCase();
    return mapped.filter((l) => l.status.toLowerCase() === sf);
  }
  return mapped;
}

async function getExecutionDetail(
  scenario_id: number,
  execution_id: string,
  region?: string
) {
  const resolvedRegion = await resolveRegion(undefined, region);
  const resp = await getApi(resolvedRegion).get(`/scenarios/${scenario_id}/logs/${execution_id}`);
  const detail = resp.data;

  // API may return { scenarioLog: { error: {...}, status: 3, ... } } or { modules: [...] }
  const scenarioLog = detail?.scenarioLog ?? detail;
  const rawStatus = normalizeStatus(scenarioLog?.status ?? detail?.status);
  const rawError = scenarioLog?.error ?? detail?.error ?? null;

  const modules: Array<{
    id?: number;
    module?: string;
    status?: string | number;
    input?: unknown;
    output?: unknown;
    error?: string;
    duration?: number;
  }> = scenarioLog?.modules ?? detail?.modules ?? [];

  const mappedModules = modules.map((m) => ({
    module_id: m.id ?? null,
    module_type: m.module ?? null,
    status: normalizeStatus(m.status),
    input_data: m.input ?? null,
    output_data: m.output ?? null,
    error_message: m.error ?? null,
    duration_ms: m.duration ?? null,
  }));

  const failedModule = mappedModules.find(
    (m) => m.status === "error" || m.status === "failed"
  );

  // If no per-module error info but we have a top-level error, synthesise a failed_module entry
  const rawErrorMsg = rawError
    ? (String((rawError as Record<string, unknown>)?.message ?? JSON.stringify(rawError)))
    : null;
  const effectiveFailed = failedModule ?? (rawError
    ? { module_id: null, module_type: null, status: "error", input_data: null, output_data: null, error_message: rawErrorMsg, duration_ms: null }
    : null);

  const overallStatus = rawStatus === "error" || effectiveFailed ? "error" : rawStatus;
  const totalDuration = mappedModules.reduce((sum, m) => sum + (m.duration_ms ?? 0), 0);

  return {
    execution_id,
    scenario_id,
    overall_status: overallStatus,
    total_modules: mappedModules.length,
    total_duration_ms: totalDuration,
    raw_status: rawStatus,
    top_level_error: rawError,
    summary: mappedModules.map((m) => `[${m.module_id}] ${m.module_type} → ${m.status}${m.error_message ? `: ${m.error_message}` : ""}`),
    modules: mappedModules,
    failed_module: effectiveFailed ?? null,
  };
}

type ErrorCategory =
  | "auth_error"
  | "timeout"
  | "not_found"
  | "validation"
  | "rate_limit"
  | "connection"
  | "unknown";

function classifyError(message: string): ErrorCategory {
  const m = message.toLowerCase();
  if (m.includes("401") || m.includes("403") || m.includes("unauthorized") || m.includes("forbidden") || m.includes("auth")) return "auth_error";
  if (m.includes("timeout") || m.includes("timed out")) return "timeout";
  if (m.includes("404") || m.includes("not found")) return "not_found";
  if (m.includes("422") || m.includes("validation") || m.includes("required") || m.includes("invalid")) return "validation";
  if (m.includes("429") || m.includes("rate limit") || m.includes("too many")) return "rate_limit";
  if (m.includes("econnrefused") || m.includes("network") || m.includes("enotfound") || m.includes("connection")) return "connection";
  return "unknown";
}

const recommendations: Record<ErrorCategory, string> = {
  auth_error: "Verifique se a conexão do módulo ainda é válida em Connections",
  timeout: "A API externa está lenta — verifique ou adicione retry",
  not_found: "Recurso não existe — verifique se os IDs no mapper estão corretos",
  validation: "Campo obrigatório ausente ou formato errado — revise o mapper",
  rate_limit: "Limite de requisições — adicione Sleep entre chamadas",
  connection: "Serviço externo fora do ar — adicione Error Handler com retry",
  unknown: "Erro desconhecido — inspecione o full_detail para mais informações",
};

async function diagnoseError(scenario_id: number, execution_id?: string, region?: string) {
  let execId = execution_id;

  if (!execId) {
    const logs = await getExecutionLogs(scenario_id, 20, region);
    const errorLog = logs.find((l) => l.status === "error" || l.status === "failed" || l.status === "3");
    if (!errorLog) {
      return {
        no_errors: true,
        message: "Nenhum erro nas últimas 20 execuções",
      };
    }
    execId = String(errorLog.id);
  }

  const detail = await getExecutionDetail(scenario_id, execId, region);
  const failed = detail.failed_module;
  const errorMsg = failed?.error_message ?? "Erro desconhecido";
  const category = classifyError(errorMsg);

  return {
    scenario_id,
    execution_id: execId,
    failed_module: failed,
    error_category: category,
    error_message: errorMsg,
    recommendation: recommendations[category],
    full_detail: detail,
  };
}

// ── Group 0: Account ──────────────────────────────────────────────────────────

async function listAllTeams(region?: string) {
  const [orgs] = await getOrgsFromAnyRegion(region);

  const results = await Promise.allSettled(
    orgs.map(async (org) => {
      const teamsResp = await axios.get(
        `https://${org.zone}/api/v2/teams`,
        {
          headers: { Authorization: `Token ${process.env.MAKE_API_KEY ?? MAKE_API_KEY}` },
          params: { organizationId: org.id },
          timeout: 30000,
        }
      );
      const teams: Array<{ id: number; name: string }> =
        teamsResp.data?.teams ?? [];
      // Populate region cache as a side effect
      const regionPart = org.zone.split(".")[0];
      for (const team of teams) {
        teamRegionCache.set(String(team.id), regionPart);
        teamNameCache.set(String(team.id), team.name);
      }
      return {
        id: org.id,
        name: org.name,
        zone: org.zone,
        teams: teams.map((t) => ({ id: t.id, name: t.name })),
      };
    })
  );

  regionCacheBuilt = true;

  const orgsWithTeams = results.map((r, i) =>
    r.status === "fulfilled"
      ? r.value
      : { id: orgs[i].id, name: orgs[i].name, zone: orgs[i].zone, teams: [], error: (r.reason as Error)?.message ?? "Falha ao buscar times" }
  );

  const totalTeams = orgsWithTeams.reduce((sum, o) => sum + o.teams.length, 0);

  return {
    total_organizations: orgs.length,
    total_teams: totalTeams,
    organizations: orgsWithTeams,
    instruction:
      "Nas demais ferramentas, passe o nome ou o id numérico do time no parâmetro team_id.",
  };
}

// ── Group 5: Dynamic ──────────────────────────────────────────────────────────

let openApiCache: Record<string, unknown> | null = null;

async function exploreMakeApi(intent: string, region?: string) {
  if (!openApiCache) {
    const resolvedRegion = await resolveRegion(undefined, region);
    const resp = await getApi(resolvedRegion).get("/openapi.json");
    openApiCache = resp.data;
  }

  const keywords = intent
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 3);

  const paths = (openApiCache as { paths?: Record<string, Record<string, unknown>> })?.paths ?? {};
  type EndpointEntry = {
    method: string;
    path: string;
    summary: string;
    description: string;
    required_params: string[];
    score: number;
  };

  const endpoints: EndpointEntry[] = [];

  for (const [pathKey, pathObj] of Object.entries(
    paths as Record<string, Record<string, unknown>>
  )) {
    for (const [method, opObj] of Object.entries(pathObj)) {
      if (!["get", "post", "patch", "put", "delete"].includes(method)) continue;
      const op = opObj as {
        summary?: string;
        description?: string;
        parameters?: Array<{ name: string; required?: boolean }>;
      };
      const text = `${pathKey} ${op.summary ?? ""} ${op.description ?? ""}`.toLowerCase();
      const score = keywords.filter((k) => text.includes(k)).length;
      if (score > 0) {
        endpoints.push({
          method: method.toUpperCase(),
          path: pathKey,
          summary: op.summary ?? "",
          description: op.description ?? "",
          required_params: (op.parameters ?? [])
            .filter((p) => p.required)
            .map((p) => p.name),
          score,
        });
      }
    }
  }

  const top5 = endpoints
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(({ score: _score, ...rest }) => rest);

  return {
    intent,
    results: top5,
    instruction: "Use call_make_api para chamar qualquer endpoint encontrado",
  };
}

async function listDataStores(team_id?: string, region?: string) {
  const { team_id: resolvedTeamId, region: resolvedRegion } = await resolveTeam(team_id, region);
  const resp = await getApi(resolvedRegion).get("/data-stores", {
    params: { teamId: resolvedTeamId },
  });
  const stores: Array<{
    id: number;
    name: string;
    records?: number;
    size?: number;
    maxSize?: number;
  }> = resp.data?.dataStores ?? [];
  return stores.map((s) => ({
    id: s.id,
    name: s.name,
    records: s.records ?? null,
    size_bytes: s.size ?? null,
    max_size_bytes: s.maxSize ?? null,
  }));
}

async function listIncompleteExecutions(scenario_id: number, region?: string) {
  const resolvedRegion = await resolveRegion(undefined, region);
  const resp = await getApi(resolvedRegion).get("/dlqs", {
    params: { scenarioId: scenario_id },
  });
  const executions: Array<{
    id?: string;
    scenarioId?: number;
    status?: string;
    reason?: string;
    createdAt?: string;
  }> = resp.data?.dlqs ?? [];
  return {
    scenario_id,
    total: executions.length,
    executions: executions.map((e) => ({
      id: e.id ?? null,
      scenario_id: e.scenarioId ?? scenario_id,
      status: e.status ?? null,
      reason: e.reason ?? null,
      created_at: e.createdAt ?? null,
    })),
  };
}

async function getIncompleteExecutionDetail(scenario_id: number, dlq_id: string, region?: string) {
  const resolvedRegion = await resolveRegion(undefined, region);
  const resp = await getApi(resolvedRegion).get(`/dlqs/${dlq_id}`);
  const dlq = resp.data?.dlq ?? resp.data;

  const errorMsg = String(dlq?.reason ?? dlq?.error ?? "Sem mensagem de erro");
  const category = classifyError(errorMsg);

  return {
    dlq_id,
    scenario_id,
    status: dlq?.status ?? null,
    reason: dlq?.reason ?? null,
    created_at: dlq?.createdAt ?? null,
    error_category: category,
    recommendation: recommendations[category],
    bundle: dlq?.bundle ?? dlq?.data ?? null,
    raw: dlq,
  };
}

async function correlateCardInExecutions(
  card_id: string,
  scenario_ids?: number[],
  team_id?: string,
  region?: string,
  limit = 5
) {
  const { team_id: resolvedTeamId, region: resolvedRegion } = await resolveTeam(team_id, region);

  let targetIds = scenario_ids;
  if (!targetIds || targetIds.length === 0) {
    const scenarios = await listScenarios(true, resolvedTeamId, resolvedRegion);
    targetIds = (scenarios as Array<{ id: number }>).map((s) => s.id).slice(0, 20);
  }

  const matches: Array<{
    scenario_id: number;
    execution_id: string;
    started: string | null;
    status: string;
    found_in_module: number | null;
  }> = [];

  for (const sid of targetIds) {
    try {
      const logs = await getExecutionLogs(sid, limit, resolvedRegion);
      for (const log of logs) {
        if (!log.id) continue;
        try {
          const detail = await getExecutionDetail(sid, String(log.id), resolvedRegion);
          const firstModule = (detail.modules as Array<{ module_id?: number; output_data?: unknown }>)[0];
          const payloadStr = JSON.stringify(firstModule?.output_data ?? "");
          if (payloadStr.includes(card_id)) {
            matches.push({
              scenario_id: sid,
              execution_id: String(log.id),
              started: log.started,
              status: log.status,
              found_in_module: firstModule?.module_id ?? null,
            });
            break;
          }
        } catch { /* pula execuções inacessíveis */ }
      }
    } catch { /* pula cenários inacessíveis */ }
  }

  return {
    card_id,
    scenarios_searched: targetIds.length,
    matches_found: matches.length,
    matches,
    note: matches.length === 0
      ? "Nenhuma execução encontrada com este card_id no payload. Verifique se o card_id é transmitido na automação Pipefy e se os cenários corretos foram incluídos."
      : "Execuções onde o card_id foi encontrado no output do módulo de webhook.",
  };
}

async function callMakeApi(
  method: string,
  endpoint: string,
  params?: object,
  body?: object,
  region?: string
) {
  const resolvedEndpoint = endpoint.replace(":teamId", MAKE_TEAM_ID);

  const resolvedRegion = await resolveRegion(undefined, region);
  const attempt = () =>
    getApi(resolvedRegion).request({
      method: method.toLowerCase(),
      url: resolvedEndpoint,
      params,
      data: body,
    });

  try {
    let resp;
    try {
      resp = await attempt();
    } catch (firstErr) {
      // Retry once on auth errors — Make.com occasionally returns 401/403
      // transiently (cold start, token validation latency). A single automatic
      // retry makes the experience seamless without masking real config issues.
      if (firstErr instanceof AxiosError && (firstErr.response?.status === 401 || firstErr.response?.status === 403)) {
        await new Promise((r) => setTimeout(r, 800));
        resp = await attempt();
      } else {
        throw firstErr;
      }
    }
    return { endpoint: resolvedEndpoint, method, result: resp.data };
  } catch (err) {
    if (err instanceof AxiosError) {
      const status = err.response?.status;
      if (status === 404) throw new Error("Endpoint não encontrado — use explore_make_api para verificar o caminho correto");
      if (status === 401 || status === 403) throw new Error("Sem permissão — verifique sua API Key");
    }
    throw err;
  }
}

// ── Group 6: New tools ────────────────────────────────────────────────────────

async function searchScenarios(query: string, team_id?: string, region?: string) {
  const { team_id: resolvedTeamId, region: resolvedRegion } = await resolveTeam(team_id, region);
  const all = await listScenarios(false, resolvedTeamId, resolvedRegion);
  const q = query.toLowerCase();
  return all.filter((s) => s.name.toLowerCase().includes(q));
}

async function getModule(scenario_id: number, module_id: number, region?: string) {
  const resolvedRegion = await resolveRegion(undefined, region);
  const resp = await getApi(resolvedRegion).get(`/scenarios/${scenario_id}/blueprint`);
  const blueprint = resp.data?.response?.blueprint ?? resp.data?.blueprint ?? resp.data;

  function findMod(obj: unknown, id: number): Record<string, unknown> | null {
    if (!obj || typeof obj !== "object") return null;
    if (Array.isArray(obj)) {
      for (const i of obj) { const r = findMod(i, id); if (r) return r; }
      return null;
    }
    const o = obj as Record<string, unknown>;
    if (o.id === id && o.module) return o;
    for (const v of Object.values(o)) { const r = findMod(v, id); if (r) return r; }
    return null;
  }

  const mod = findMod(blueprint, module_id);
  if (!mod) throw new Error(`Módulo ${module_id} não encontrado no cenário ${scenario_id}`);
  const meta = mod.metadata as Record<string, unknown> | undefined;
  const designer = meta?.designer as Record<string, unknown> | undefined;
  return {
    scenario_id,
    module_id,
    module_type: mod.module,
    label: designer?.name ?? null,
    mapper: mod.mapper ?? {},
  };
}

async function updateModuleMapper(scenario_id: number, module_id: number, mapper: object, region?: string) {
  const resolvedRegion = await resolveRegion(undefined, region);
  const resp = await getApi(resolvedRegion).get(`/scenarios/${scenario_id}/blueprint`);
  const blueprintWrapper = resp.data?.response ?? resp.data;
  const blueprint = blueprintWrapper?.blueprint ?? blueprintWrapper;

  function findAndUpdate(obj: unknown, id: number, newMapper: object): boolean {
    if (!obj || typeof obj !== "object") return false;
    if (Array.isArray(obj)) {
      for (const i of obj) { if (findAndUpdate(i, id, newMapper)) return true; }
      return false;
    }
    const o = obj as Record<string, unknown>;
    if (o.id === id && o.module) { o.mapper = { ...(o.mapper as object ?? {}), ...newMapper }; return true; }
    for (const v of Object.values(o)) { if (findAndUpdate(v, id, newMapper)) return true; }
    return false;
  }

  const found = findAndUpdate(blueprint, module_id, mapper);
  if (!found) throw new Error(`Módulo ${module_id} não encontrado no cenário ${scenario_id}`);

  await getApi(resolvedRegion).patch(`/scenarios/${scenario_id}`, { blueprint: JSON.stringify(blueprint) });
  return { scenario_id, module_id, updated: true };
}

async function resolveMakeUrl(url: string) {
  const regionMatch = url.match(/https?:\/\/([\w]+)\.make\.com/);
  const effectiveRegion = regionMatch?.[1] ?? MAKE_REGION;
  const scenarioMatch = url.match(/\/scenarios\/(\d+)/);
  const logMatch = url.match(/\/logs\/([a-f0-9]{32})/);

  if (!scenarioMatch) throw new Error("URL não contém ID de cenário válido");

  const scenario_id = parseInt(scenarioMatch[1]);
  const execution_id = logMatch?.[1];

  const parsed = { scenario_id, execution_id: execution_id ?? null, region: effectiveRegion };

  if (execution_id) {
    const diagnosis = await diagnoseError(scenario_id, execution_id, effectiveRegion);
    return { parsed, diagnosis };
  } else {
    const scenarioResp = await getApi(effectiveRegion).get(`/scenarios/${scenario_id}`);
    const s = (scenarioResp.data?.scenario ?? scenarioResp.data) as MakeScenario;
    return { parsed, scenario: { id: s.id, name: s.name, active: s.isActive, scheduling: s.scheduling } };
  }
}

async function documentScenario(scenario_id: number, region?: string) {
  const resolvedRegion = await resolveRegion(undefined, region);
  const scenarioData = await getScenario(scenario_id, resolvedRegion);
  const { name, active, scheduling, modules, blueprint } = scenarioData;

  let doc = `# Cenário: ${name}\n\n`;
  doc += `**Status:** ${active ? "ativo" : "**inativo**"}\n`;
  if (scheduling) {
    const sched = scheduling as { type?: string; interval?: number };
    const schedText =
      sched.type === "indefinitely" ? "executa continuamente" :
      sched.type === "on_demand" ? "executa sob demanda (manual)" :
      sched.interval ? `agendado a cada ${sched.interval}s` :
      JSON.stringify(sched);
    doc += `**Agendamento:** ${schedText}\n`;
  }
  doc += `**Módulos:** ${modules.length}\n\n---\n\n## Fluxo de Execução\n\n`;

  const flow: Array<{
    id: number;
    module: string;
    metadata?: { designer?: { name?: string } };
    mapper?: Record<string, unknown>;
  }> = blueprint?.flow ?? [];

  for (let i = 0; i < flow.length; i++) {
    const mod = flow[i];
    const label = mod.metadata?.designer?.name ?? `Módulo ${mod.id}`;
    const moduleType = mod.module ?? "";
    const [app, action] = moduleType.split(":");

    let description: string;
    if (i === 0) {
      if (moduleType.includes("webhook") || moduleType.includes("hook"))
        description = "**Trigger:** Aguarda chamada de webhook externo";
      else if (moduleType.includes("schedule") || moduleType.includes("cron"))
        description = "**Trigger:** Executa por agendamento";
      else
        description = `**Trigger:** ${app} — ${action ?? moduleType}`;
    } else {
      if (moduleType.includes("flow:router"))
        description = "**Router:** Divide o fluxo em múltiplos caminhos condicionais";
      else if (moduleType.includes("flow:aggregator") || moduleType.includes("array-aggregator"))
        description = "**Agregador:** Consolida múltiplos bundles em um único";
      else if (moduleType.includes("flow:iterator"))
        description = "**Iterator:** Itera sobre cada item de uma lista";
      else if (moduleType.includes("flow:sleep"))
        description = "**Sleep:** Pausa a execução por um intervalo definido";
      else if (moduleType.includes("http")) {
        const url = mod.mapper?.url ?? mod.mapper?.uri;
        description = url && String(url).includes("pipefy")
          ? `**HTTP → Pipefy:** Chamada GraphQL para \`api.pipefy.com/graphql\``
          : `**HTTP:** Requisição para \`${url ?? "URL dinâmica"}\``;
      } else if (moduleType.includes("json:"))
        description = `**JSON:** Transforma/analisa dados JSON`;
      else if (moduleType.includes("tools:set-variable") || moduleType.includes("builtin:basicfeeder"))
        description = `**Variável:** Define ou alimenta dados no fluxo`;
      else
        description = `**${app}:** ${action ?? "ação"}`;
    }

    doc += `**${i + 1}. ${label}** \`${moduleType}\`\n${description}\n\n`;
  }

  const routerCount = flow.filter((m) => m.module === "flow:router").length;
  if (routerCount > 0)
    doc += `> Este cenário possui ${routerCount} router(s) — use \`get_scenario\` para inspecionar as rotas no blueprint completo.\n\n`;

  const httpModules = flow.filter(
    (m) => m.module?.includes("http") || m.module?.includes("pipefy")
  );
  const pipefyCalls = httpModules.filter((m) => {
    const url = String(m.mapper?.url ?? m.mapper?.uri ?? "");
    return url.includes("pipefy") || url.includes("graphql");
  });

  if (pipefyCalls.length > 0) {
    doc += `## Chamadas ao Pipefy (${pipefyCalls.length})\n\n`;
    for (const m of pipefyCalls) {
      const label = m.metadata?.designer?.name ?? `Módulo ${m.id}`;
      doc += `- **${label}** (\`${m.module}\`) — chama \`api.pipefy.com/graphql\`\n`;
    }
    doc += "\n";
  }

  return {
    scenario_id,
    scenario_name: name,
    active,
    modules_count: modules.length,
    has_router: routerCount > 0,
    pipefy_calls_count: pipefyCalls.length,
    documentation_markdown: doc,
  };
}

async function getScenarioStats(scenario_id: number, region?: string) {
  const resolvedRegion = await resolveRegion(undefined, region);
  const logs = await getExecutionLogs(scenario_id, 50, resolvedRegion);

  if (logs.length === 0) {
    return {
      scenario_id,
      executions_analyzed: 0,
      note: "Nenhuma execução encontrada para este cenário.",
    };
  }

  const total = logs.length;
  const success = logs.filter((l) => l.status === "success").length;
  const errors = logs.filter((l) => l.status === "error").length;
  const warnings = logs.filter((l) => l.status === "warning").length;

  const durations = logs.filter((l) => l.duration_ms != null).map((l) => l.duration_ms as number);
  const avgDuration = durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null;
  const maxDuration = durations.length > 0 ? Math.max(...durations) : null;
  const minDuration = durations.length > 0 ? Math.min(...durations) : null;

  const errorMessages: Record<string, number> = {};
  for (const l of logs) {
    if (l.error) errorMessages[l.error] = (errorMessages[l.error] ?? 0) + 1;
  }
  const topErrors = Object.entries(errorMessages)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([message, count]) => ({ message, count, category: classifyError(message) }));

  // Trend: compare last 10 vs previous 10 executions
  const recent10 = logs.slice(0, 10);
  const prev10 = logs.slice(10, 20);
  const recentErrorRate = recent10.filter((l) => l.status === "error").length / recent10.length;
  const prevErrorRate = prev10.length > 0 ? prev10.filter((l) => l.status === "error").length / prev10.length : null;
  const trend =
    prevErrorRate === null ? "dados insuficientes" :
    recentErrorRate > prevErrorRate + 0.1 ? "piorando" :
    recentErrorRate < prevErrorRate - 0.1 ? "melhorando" :
    "estável";

  const successRate = Math.round((success / total) * 100);
  const recommendation =
    errors === 0 ? "Cenário saudável — nenhum erro nas últimas execuções." :
    successRate < 50 ? "Taxa de erro crítica (>50%) — investigar imediatamente com diagnose_error." :
    successRate < 80 ? "Taxa de erro alta (>20%) — revisar os módulos em top_errors." :
    "Taxa de erro baixa — monitorar padrões recorrentes em top_errors.";

  return {
    scenario_id,
    executions_analyzed: total,
    success_count: success,
    error_count: errors,
    warning_count: warnings,
    success_rate: `${successRate}%`,
    error_rate: `${Math.round((errors / total) * 100)}%`,
    avg_duration_ms: avgDuration,
    max_duration_ms: maxDuration,
    min_duration_ms: minDuration,
    recent_trend: trend,
    top_errors: topErrors,
    reliability_score: successRate,
    recommendation,
  };
}

async function findRedundantScenarios(team_id?: string, region?: string) {
  const { team_id: resolvedTeamId, region: resolvedRegion } = await resolveTeam(team_id, region);
  const all = await listScenarios(false, resolvedTeamId, resolvedRegion);

  type ScenarioSig = {
    id: number;
    name: string;
    active: boolean;
    trigger_app: string;
    destination_apps: string[];
    modules_count: number;
  };

  const signatures: ScenarioSig[] = [];
  const BATCH = 5;

  for (let i = 0; i < Math.min((all as unknown[]).length, 60); i += BATCH) {
    const batch = (all as Array<{ id: number; name: string; active: boolean }>).slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map(async (s) => {
        const detail = await getScenario(s.id, resolvedRegion);
        const flow: Array<{ module: string }> = detail.blueprint?.flow ?? [];
        const apps = flow.map((m) => m.module?.split(":")?.[0] ?? "unknown");
        return {
          id: s.id,
          name: s.name,
          active: s.active,
          trigger_app: apps[0] ?? "unknown",
          destination_apps: [...new Set(apps.slice(1))],
          modules_count: flow.length,
        } as ScenarioSig;
      })
    );
    for (const r of results) {
      if (r.status === "fulfilled") signatures.push(r.value);
    }
  }

  type RedundantGroup = {
    reason: string;
    scenarios: Array<{ id: number; name: string; active: boolean }>;
  };
  const groups: RedundantGroup[] = [];

  // Group by trigger app, find pairs with high destination overlap
  const byTrigger = new Map<string, ScenarioSig[]>();
  for (const sig of signatures) {
    if (!byTrigger.has(sig.trigger_app)) byTrigger.set(sig.trigger_app, []);
    byTrigger.get(sig.trigger_app)!.push(sig);
  }

  for (const [triggerApp, group] of byTrigger) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        const aSet = new Set(a.destination_apps);
        const bSet = new Set(b.destination_apps);
        const inter = [...aSet].filter((x) => bSet.has(x));
        const union = new Set([...aSet, ...bSet]);
        const sim = union.size > 0 ? inter.length / union.size : 0;
        if (sim >= 0.7 && a.destination_apps.length > 0) {
          groups.push({
            reason: `Mesmo trigger (${triggerApp}) e destinos similares (${Math.round(sim * 100)}% de sobreposição): ${inter.join(", ")}`,
            scenarios: [
              { id: a.id, name: a.name, active: a.active },
              { id: b.id, name: b.name, active: b.active },
            ],
          });
        }
      }
    }
  }

  // Name similarity check
  for (let i = 0; i < signatures.length; i++) {
    for (let j = i + 1; j < signatures.length; j++) {
      const a = signatures[i];
      const b = signatures[j];
      if (groups.some((g) => g.scenarios.some((s) => s.id === a.id) && g.scenarios.some((s) => s.id === b.id))) continue;
      const wordsA = new Set(a.name.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
      const wordsB = new Set(b.name.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
      const inter = [...wordsA].filter((x) => wordsB.has(x));
      const union = new Set([...wordsA, ...wordsB]);
      const nameSim = union.size > 0 ? inter.length / union.size : 0;
      if (nameSim >= 0.6 && wordsA.size >= 2) {
        groups.push({
          reason: `Nomes similares (${Math.round(nameSim * 100)}% de palavras em comum): "${inter.join('", "')}"`,
          scenarios: [
            { id: a.id, name: a.name, active: a.active },
            { id: b.id, name: b.name, active: b.active },
          ],
        });
      }
    }
  }

  return {
    scenarios_analyzed: signatures.length,
    redundant_groups_found: groups.length,
    groups,
    note:
      groups.length === 0
        ? "Nenhuma redundância detectada nos cenários analisados."
        : "Use get_scenario em cada par para confirmar redundância antes de consolidar ou desativar.",
  };
}

// ── MCP Server ─────────────────────────────────────────────────────────────────
const server = new Server(
  { name: "make-mcp", version: "2.0.0" },
  { capabilities: { tools: {} } }
);

const REGION_PROP = { type: "string", description: "Região Make.com: 'us1', 'us2', 'eu1', etc. (usa MAKE_REGION do env se omitido)" };

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    // ── Group 1: Read ──
    {
      name: "list_scenarios",
      description: "Lista cenários do Make.com. Filtra por ativos se active_only=true.",
      inputSchema: {
        type: "object",
        properties: {
          active_only: { type: "boolean", description: "Retornar apenas cenários ativos" },
          team_id: { type: "string", description: "ID numérico ou nome do time (ex: 'Píer Geral' ou '551168'). Usa env se omitido." },
          region: REGION_PROP,
        },
        required: [],
      },
    },
    {
      name: "get_scenario",
      description: "Retorna detalhes completos de um cenário incluindo blueprint e lista de módulos.",
      inputSchema: {
        type: "object",
        properties: {
          scenario_id: { type: "number", description: "ID do cenário" },
          region: REGION_PROP,
        },
        required: ["scenario_id"],
      },
    },
    {
      name: "list_connections",
      description: "Lista todas as conexões (integrações autenticadas) do time.",
      inputSchema: {
        type: "object",
        properties: {
          team_id: { type: "string", description: "ID numérico ou nome do time (ex: 'Píer Geral' ou '551168'). Opcional." },
          region: REGION_PROP,
        },
        required: [],
      },
    },
    {
      name: "list_webhooks",
      description: "Lista todos os webhooks registrados no time.",
      inputSchema: {
        type: "object",
        properties: {
          team_id: { type: "string", description: "ID numérico ou nome do time (ex: 'Píer Geral' ou '551168'). Opcional." },
          region: REGION_PROP,
        },
        required: [],
      },
    },
    // ── Group 2: Write ──
    {
      name: "create_scenario",
      description: "Cria um novo cenário a partir de um blueprint JSON.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Nome do cenário" },
          blueprint: { type: "object", description: "Blueprint do cenário" },
          team_id: { type: "string", description: "ID numérico ou nome do time (ex: 'Píer Geral' ou '551168'). Opcional." },
          region: REGION_PROP,
        },
        required: ["name", "blueprint"],
      },
    },
    {
      name: "update_scenario",
      description: "Atualiza o blueprint de um cenário existente.",
      inputSchema: {
        type: "object",
        properties: {
          scenario_id: { type: "number", description: "ID do cenário" },
          blueprint: { type: "object", description: "Novo blueprint" },
          region: REGION_PROP,
        },
        required: ["scenario_id", "blueprint"],
      },
    },
    {
      name: "clone_scenario",
      description: "Clona um cenário existente com um novo nome.",
      inputSchema: {
        type: "object",
        properties: {
          scenario_id: { type: "number", description: "ID do cenário a clonar" },
          new_name: { type: "string", description: "Nome do clone" },
          team_id: { type: "string", description: "ID numérico ou nome do time (ex: 'Píer Geral' ou '551168'). Opcional." },
          region: REGION_PROP,
        },
        required: ["scenario_id", "new_name"],
      },
    },
    {
      name: "toggle_scenario",
      description: "Ativa ou desativa um cenário.",
      inputSchema: {
        type: "object",
        properties: {
          scenario_id: { type: "number", description: "ID do cenário" },
          active: { type: "boolean", description: "true para ativar, false para desativar" },
          region: REGION_PROP,
        },
        required: ["scenario_id", "active"],
      },
    },
    // ── Group 3: Schema ──
    {
      name: "get_app_modules",
      description: "Lista todos os módulos disponíveis de um app Make (ex: 'google-sheets', 'http').",
      inputSchema: {
        type: "object",
        properties: {
          app_name: { type: "string", description: "Nome do app no Make (slug)" },
          region: REGION_PROP,
        },
        required: ["app_name"],
      },
    },
    {
      name: "get_module_schema",
      description: "Retorna o schema completo (input/output) de um módulo específico de um app.",
      inputSchema: {
        type: "object",
        properties: {
          app_name: { type: "string", description: "Nome do app" },
          module_name: { type: "string", description: "Nome do módulo" },
          region: REGION_PROP,
        },
        required: ["app_name", "module_name"],
      },
    },
    {
      name: "get_webhook_payload",
      description: "Extrai o payload de uma execução bem-sucedida para mapear variáveis do webhook.",
      inputSchema: {
        type: "object",
        properties: {
          scenario_id: { type: "number", description: "ID do cenário com webhook" },
          region: REGION_PROP,
        },
        required: ["scenario_id"],
      },
    },
    // ── Group 4: Diagnostics ──
    {
      name: "get_execution_logs",
      description: "Lista logs de execução de um cenário com status e erros.",
      inputSchema: {
        type: "object",
        properties: {
          scenario_id: { type: "number", description: "ID do cenário" },
          limit: { type: "number", description: "Número de registros (default 10)" },
          status: { type: "string", description: "Filtrar por status: 'error', 'success', 'warning' (opcional)" },
          region: REGION_PROP,
        },
        required: ["scenario_id"],
      },
    },
    {
      name: "get_execution_detail",
      description: "Retorna detalhe completo de uma execução específica, módulo a módulo.",
      inputSchema: {
        type: "object",
        properties: {
          scenario_id: { type: "number", description: "ID do cenário" },
          execution_id: { type: "string", description: "ID da execução" },
          region: REGION_PROP,
        },
        required: ["scenario_id", "execution_id"],
      },
    },
    {
      name: "diagnose_error",
      description: "Diagnostica e classifica o erro de uma execução com recomendação de correção.",
      inputSchema: {
        type: "object",
        properties: {
          scenario_id: { type: "number", description: "ID do cenário" },
          execution_id: { type: "string", description: "ID da execução (opcional — busca o último erro se omitido)" },
          region: REGION_PROP,
        },
        required: ["scenario_id"],
      },
    },
    // ── Group 6: Data & Execution Control ──
    {
      name: "list_data_stores",
      description: "Lista os Data Stores do time com nome, número de registros e tamanho.",
      inputSchema: {
        type: "object",
        properties: {
          team_id: { type: "string", description: "ID numérico ou nome do time (ex: 'Píer Geral' ou '551168'). Opcional." },
          region: REGION_PROP,
        },
        required: [],
      },
    },
    {
      name: "list_incomplete_executions",
      description: "Lista execuções incompletas de um cenário (erros pendentes de retry ou resolução manual).",
      inputSchema: {
        type: "object",
        properties: {
          scenario_id: { type: "number", description: "ID do cenário" },
          region: REGION_PROP,
        },
        required: ["scenario_id"],
      },
    },
    // ── Group 0: Account ──
    {
      name: "list_all_teams",
      description:
        "Lista todos os times do Make.com aos quais esta conta tem acesso, com a região de cada org. Use sempre que precisar identificar em qual time e região operar para um cliente específico, antes de chamar qualquer outra ferramenta.",
      inputSchema: {
        type: "object",
        properties: {
          region: REGION_PROP,
        },
        required: [],
      },
    },
    // ── Group 5: Dynamic ──
    {
      name: "explore_make_api",
      description: "Pesquisa o OpenAPI spec do Make.com para encontrar endpoints relevantes para um objetivo.",
      inputSchema: {
        type: "object",
        properties: {
          intent: { type: "string", description: "Descrição do que você quer fazer (ex: 'listar data stores do time')" },
          region: REGION_PROP,
        },
        required: ["intent"],
      },
    },
    {
      name: "call_make_api",
      description: "Chama qualquer endpoint da API do Make.com diretamente.",
      inputSchema: {
        type: "object",
        properties: {
          method: { type: "string", description: "Método HTTP (GET, POST, PATCH, DELETE)" },
          endpoint: { type: "string", description: "Caminho do endpoint (ex: /data-stores)" },
          params: { type: "object", description: "Query parameters (opcional)" },
          body: { type: "object", description: "Request body (opcional)" },
          region: REGION_PROP,
        },
        required: ["method", "endpoint"],
      },
    },
    // ── Group 6: New tools ──
    {
      name: "search_scenarios",
      description: "Busca cenários pelo nome (parcial, case-insensitive). Use antes de get_scenario quando não souber o ID exato.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Texto a buscar no nome do cenário" },
          team_id: { type: "string", description: "ID numérico ou nome do time (ex: 'Píer Geral' ou '551168'). Opcional." },
          region: REGION_PROP,
        },
        required: ["query"],
      },
    },
    {
      name: "get_module",
      description: "Retorna o mapper de um módulo específico sem baixar o blueprint inteiro. Ideal para inspecionar e diagnosticar módulos individualmente.",
      inputSchema: {
        type: "object",
        properties: {
          scenario_id: { type: "number", description: "ID do cenário" },
          module_id: { type: "number", description: "ID do módulo no blueprint" },
          region: REGION_PROP,
        },
        required: ["scenario_id", "module_id"],
      },
    },
    {
      name: "update_module_mapper",
      description: "Atualiza o mapper de um módulo específico sem precisar do blueprint completo. Usa patch cirúrgico: busca o blueprint, altera só o módulo indicado e salva.",
      inputSchema: {
        type: "object",
        properties: {
          scenario_id: { type: "number", description: "ID do cenário" },
          module_id: { type: "number", description: "ID do módulo no blueprint" },
          mapper: { type: "object", description: "Campos do mapper a atualizar (merge com o existente)" },
          region: REGION_PROP,
        },
        required: ["scenario_id", "module_id", "mapper"],
      },
    },
    {
      name: "resolve_make_url",
      description: "Recebe uma URL do Make.com (cenário ou log de execução) e resolve automaticamente: extrai IDs, região e retorna diagnóstico de erro (se URL de log) ou info do cenário (se URL de edição).",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL do Make.com (ex: https://eu1.make.com/123/scenarios/456 ou URL de log)" },
        },
        required: ["url"],
      },
    },
    {
      name: "find_redundant_scenarios",
      description: "Analisa cenários do time em busca de redundâncias: pares com mesmo trigger e destinos similares, ou nomes parecidos. Útil em auditorias para identificar duplicações acidentais.",
      inputSchema: {
        type: "object",
        properties: {
          team_id: { type: "string", description: "ID numérico ou nome do time (ex: 'Píer Geral' ou '551168'). Opcional." },
          region: REGION_PROP,
        },
        required: [],
      },
    },
    {
      name: "document_scenario",
      description: "Gera documentação em markdown de um cenário Make.com: o que cada módulo faz, fluxo de execução em linguagem natural, chamadas ao Pipefy identificadas. Use para documentar cenários complexos.",
      inputSchema: {
        type: "object",
        properties: {
          scenario_id: { type: "number", description: "ID do cenário" },
          region: REGION_PROP,
        },
        required: ["scenario_id"],
      },
    },
    {
      name: "get_scenario_stats",
      description: "Agrega estatísticas de execução de um cenário: taxa de sucesso/erro, duração média, tendência recente e top erros mais frequentes. Use para avaliar a confiabilidade de um cenário.",
      inputSchema: {
        type: "object",
        properties: {
          scenario_id: { type: "number", description: "ID do cenário" },
          region: REGION_PROP,
        },
        required: ["scenario_id"],
      },
    },
    {
      name: "get_incomplete_execution_detail",
      description: "Abre o payload completo de uma execução incompleta (DLQ): dados do bundle que falhou, categoria do erro e recomendação de correção. Use após list_incomplete_executions para investigar o erro real.",
      inputSchema: {
        type: "object",
        properties: {
          scenario_id: { type: "number", description: "ID do cenário" },
          dlq_id: { type: "string", description: "ID da execução incompleta (retornado por list_incomplete_executions)" },
          region: REGION_PROP,
        },
        required: ["scenario_id", "dlq_id"],
      },
    },
    {
      name: "correlate_pipefy_event",
      description: "Dado um card_id do Pipefy, busca em quais execuções Make o card aparece no payload do webhook. Fecha o loop entre um card com problema e a execução correspondente no Make.",
      inputSchema: {
        type: "object",
        properties: {
          card_id: { type: "string", description: "ID do card Pipefy (ex: '123456')" },
          scenario_ids: { type: "array", items: { type: "number" }, description: "IDs dos cenários Make a pesquisar (opcional — busca em até 20 cenários ativos se omitido)" },
          team_id: { type: "string", description: "ID numérico ou nome do time (ex: 'Píer Geral' ou '551168'). Opcional." },
          region: REGION_PROP,
          limit: { type: "number", description: "Execuções por cenário a verificar (default 5)" },
        },
        required: ["card_id"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result: unknown;

    const region = args?.region as string | undefined;

    switch (name) {
      case "list_scenarios":
        result = await listScenarios(
          args?.active_only as boolean | undefined,
          args?.team_id as string | undefined,
          region
        );
        break;

      case "get_scenario":
        result = await getScenario(args?.scenario_id as number, region);
        break;

      case "list_connections":
        result = await listConnections(args?.team_id as string | undefined, region);
        break;

      case "list_webhooks":
        result = await listWebhooks(args?.team_id as string | undefined, region);
        break;

      case "create_scenario":
        result = await createScenario(
          args?.name as string,
          args?.blueprint as object,
          args?.team_id as string | undefined,
          region
        );
        break;

      case "update_scenario":
        result = await updateScenario(
          args?.scenario_id as number,
          args?.blueprint as object,
          region
        );
        break;

      case "clone_scenario":
        result = await cloneScenario(
          args?.scenario_id as number,
          args?.new_name as string,
          args?.team_id as string | undefined,
          region
        );
        break;

      case "toggle_scenario":
        result = await toggleScenario(
          args?.scenario_id as number,
          args?.active as boolean,
          region
        );
        break;

      case "get_app_modules":
        result = await getAppModules(args?.app_name as string, region);
        break;

      case "get_module_schema":
        result = await getModuleSchema(
          args?.app_name as string,
          args?.module_name as string,
          region
        );
        break;

      case "get_webhook_payload":
        result = await getWebhookPayload(args?.scenario_id as number, region);
        break;

      case "get_execution_logs":
        result = await getExecutionLogs(
          args?.scenario_id as number,
          args?.limit as number | undefined,
          region,
          args?.status as string | undefined
        );
        break;

      case "get_execution_detail":
        result = await getExecutionDetail(
          args?.scenario_id as number,
          args?.execution_id as string,
          region
        );
        break;

      case "diagnose_error":
        result = await diagnoseError(
          args?.scenario_id as number,
          args?.execution_id as string | undefined,
          region
        );
        break;

      case "list_data_stores":
        result = await listDataStores(args?.team_id as string | undefined, region);
        break;

      case "list_incomplete_executions":
        result = await listIncompleteExecutions(args?.scenario_id as number, region);
        break;

      case "list_all_teams":
        result = await listAllTeams(region);
        break;

      case "explore_make_api":
        result = await exploreMakeApi(args?.intent as string, region);
        break;

      case "call_make_api":
        result = await callMakeApi(
          args?.method as string,
          args?.endpoint as string,
          args?.params as object | undefined,
          args?.body as object | undefined,
          region
        );
        break;

      case "search_scenarios":
        result = await searchScenarios(
          args?.query as string,
          args?.team_id as string | undefined,
          region
        );
        break;

      case "get_module":
        result = await getModule(
          args?.scenario_id as number,
          args?.module_id as number,
          region
        );
        break;

      case "update_module_mapper":
        result = await updateModuleMapper(
          args?.scenario_id as number,
          args?.module_id as number,
          args?.mapper as object,
          region
        );
        break;

      case "resolve_make_url":
        result = await resolveMakeUrl(args?.url as string);
        break;

      case "find_redundant_scenarios":
        result = await findRedundantScenarios(args?.team_id as string | undefined, region);
        break;

      case "document_scenario":
        result = await documentScenario(args?.scenario_id as number, region);
        break;

      case "get_scenario_stats":
        result = await getScenarioStats(args?.scenario_id as number, region);
        break;

      case "get_incomplete_execution_detail":
        result = await getIncompleteExecutionDetail(
          args?.scenario_id as number,
          args?.dlq_id as string,
          region
        );
        break;

      case "correlate_pipefy_event":
        result = await correlateCardInExecutions(
          args?.card_id as string,
          args?.scenario_ids as number[] | undefined,
          args?.team_id as string | undefined,
          region,
          args?.limit as number | undefined
        );
        break;

      default:
        throw new Error(`Ferramenta desconhecida: ${name}`);
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: makeErrorMessage(err, name) }],
      isError: true,
    };
  }
});

// ── Start ──────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT ? parseInt(process.env.PORT) : undefined;

if (PORT) {
  // HTTP/SSE mode — usado no Railway / LibreChat remoto
  let sseTransport: SSEServerTransport | null = null;

  // ── Microsoft OAuth (Entra ID) ────────────────────────────────────────────
  const AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID ?? "";
  const AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET ?? "";
  const AZURE_TENANT_ID = process.env.AZURE_TENANT_ID ?? "";
  const SESSION_SECRET = process.env.SESSION_SECRET ?? crypto.randomBytes(32).toString("hex");
  const SERVER_BASE_URL = (process.env.SERVER_BASE_URL ?? `http://localhost:${PORT}`).replace(/\/$/, "");

  function signSession(email: string, name: string): string {
    const h = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const p = Buffer.from(JSON.stringify({
      email, name,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 90 * 86400,
    })).toString("base64url");
    const s = crypto.createHmac("sha256", SESSION_SECRET).update(`${h}.${p}`).digest("base64url");
    return `${h}.${p}.${s}`;
  }

  function verifySession(token: string): { email: string; name: string } | null {
    try {
      const [h, p, s] = token.split(".");
      if (!h || !p || !s) return null;
      const expected = crypto.createHmac("sha256", SESSION_SECRET).update(`${h}.${p}`).digest("base64url");
      if (s !== expected) return null;
      const payload = JSON.parse(Buffer.from(p, "base64url").toString()) as { email: string; name: string; exp: number };
      if (payload.exp < Math.floor(Date.now() / 1000)) return null;
      return { email: payload.email, name: payload.name };
    } catch { return null; }
  }

  const PAGE_LANDING = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Make MCP — Vincular conta</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f0f2f5;display:flex;align-items:center;justify-content:center;min-height:100vh}
.card{background:#fff;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,.1);padding:48px;max-width:420px;width:100%;text-align:center}
.icon{font-size:56px;margin-bottom:20px}
h1{font-size:22px;color:#1a1a1a;margin-bottom:12px}
p{color:#666;line-height:1.6;margin-bottom:32px}
.btn{display:inline-flex;align-items:center;gap:10px;background:#0078d4;color:#fff;text-decoration:none;padding:14px 28px;border-radius:6px;font-size:15px;font-weight:500}
.btn:hover{background:#006ac1}
</style>
</head>
<body>
<div class="card">
<div class="icon">&#128279;</div>
<h1>Make MCP Server</h1>
<p>Para usar este servidor MCP, vincule sua conta Microsoft da P&#237;er. O acesso &#233; restrito a usu&#225;rios da organiza&#231;&#227;o.</p>
<a href="/login" class="btn">
<svg width="20" height="20" viewBox="0 0 21 21" fill="white" xmlns="http://www.w3.org/2000/svg"><rect x="1" y="1" width="9" height="9"/><rect x="11" y="1" width="9" height="9"/><rect x="1" y="11" width="9" height="9"/><rect x="11" y="11" width="9" height="9"/></svg>
Vincular com Microsoft
</a>
</div>
</body>
</html>`;

  const pageSuccess = (name: string, token: string) => `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Autentica&#231;&#227;o conclu&#237;da</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f0f2f5;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
.card{background:#fff;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,.1);padding:40px;max-width:580px;width:100%}
.badge{background:#e8f5e9;color:#2e7d32;border-radius:20px;padding:6px 14px;font-size:13px;font-weight:600;display:inline-block;margin-bottom:20px}
h1{font-size:22px;color:#1a1a1a;margin-bottom:6px}
.sub{color:#666;margin-bottom:28px}
h2{font-size:14px;font-weight:600;color:#444;margin-bottom:10px;margin-top:24px}
.token-box{background:#f8f9fa;border:1px solid #e0e0e0;border-radius:8px;padding:14px;font-family:monospace;font-size:12px;word-break:break-all;color:#333;margin-bottom:10px}
.copy-btn{background:#0078d4;color:#fff;border:none;padding:10px 20px;border-radius:6px;cursor:pointer;font-size:14px;margin-bottom:6px}
.copy-btn:hover{background:#006ac1}.copy-btn.ok{background:#2e7d32}
.exp{color:#999;font-size:12px;margin-bottom:24px}
.info{background:#f8f9fa;border-radius:8px;padding:20px}
.info p{color:#555;font-size:13px;margin-bottom:10px}
pre{background:#1e1e1e;color:#d4d4d4;padding:14px;border-radius:6px;font-size:11px;overflow-x:auto;white-space:pre-wrap}
</style>
</head>
<body>
<div class="card">
<div class="badge">&#10003; Autentica&#231;&#227;o conclu&#237;da</div>
<h1>Bem-vindo, ${name}!</h1>
<p class="sub">Sua conta Microsoft foi vinculada. Copie o token abaixo e configure no Claude Code.</p>
<h2>Token de acesso</h2>
<div class="token-box" id="tok">${token}</div>
<button class="copy-btn" id="cb" onclick="copy()">Copiar token</button>
<p class="exp">V&#225;lido por 90 dias. Para renovar, acesse esta p&#225;gina novamente.</p>
<div class="info">
<h2>Como configurar no Claude Code</h2>
<p>Edite a configura&#231;&#227;o do Claude Code e adicione o servidor com o token:</p>
<pre>{
  "mcpServers": {
    "make-mcp": {
      "url": "${SERVER_BASE_URL}/sse",
      "headers": {
        "Authorization": "Bearer ${token}"
      }
    }
  }
}</pre>
</div>
</div>
<script>
function copy(){
  navigator.clipboard.writeText(document.getElementById('tok').textContent).then(function(){
    var b=document.getElementById('cb');
    b.textContent='&#10003; Copiado!';b.classList.add('ok');
    setTimeout(function(){b.textContent='Copiar token';b.classList.remove('ok')},2000);
  });
}
</script>
</body>
</html>`;

  const pageError = (msg: string) => `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"><title>Erro</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,sans-serif;background:#f0f2f5;display:flex;align-items:center;justify-content:center;min-height:100vh}.card{background:#fff;border-radius:12px;padding:48px;max-width:420px;width:100%;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.1)}h1{color:#c62828;margin-bottom:16px;font-size:20px}p{color:#666;margin-bottom:24px;line-height:1.6}a{color:#0078d4;text-decoration:none}</style>
</head>
<body>
<div class="card"><h1>Erro de autentica&#231;&#227;o</h1><p>${msg}</p><a href="/">&#8592; Tentar novamente</a></div>
</body>
</html>`;

  const httpServer = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const reqUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = reqUrl.pathname;

    // ── Rotas públicas ─────────────────────────────────────────────────────────
    if (path === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("OK");
      return;
    }

    if (path === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(PAGE_LANDING);
      return;
    }

    if (path === "/login") {
      if (!AZURE_CLIENT_ID || !AZURE_TENANT_ID) {
        res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
        res.end(pageError("Servidor não configurado para autenticação Microsoft. Defina AZURE_CLIENT_ID e AZURE_TENANT_ID."));
        return;
      }
      const params = new URLSearchParams({
        client_id: AZURE_CLIENT_ID,
        response_type: "code",
        redirect_uri: `${SERVER_BASE_URL}/auth/callback`,
        scope: "openid profile email User.Read",
        response_mode: "query",
      });
      res.writeHead(302, { Location: `https://login.microsoftonline.com/${AZURE_TENANT_ID}/oauth2/v2.0/authorize?${params}` });
      res.end();
      return;
    }

    if (path === "/auth/callback") {
      const code = reqUrl.searchParams.get("code");
      const oauthError = reqUrl.searchParams.get("error");
      if (oauthError || !code) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(pageError(`Autenticação recusada pela Microsoft: ${oauthError ?? "código ausente"}`));
        return;
      }
      try {
        const tokenParams = new URLSearchParams({
          client_id: AZURE_CLIENT_ID,
          client_secret: AZURE_CLIENT_SECRET,
          code,
          redirect_uri: `${SERVER_BASE_URL}/auth/callback`,
          grant_type: "authorization_code",
          scope: "openid profile email User.Read",
        });
        const tokenResp = await axios.post(
          `https://login.microsoftonline.com/${AZURE_TENANT_ID}/oauth2/v2.0/token`,
          tokenParams.toString(),
          { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
        );
        const msAccessToken: string = tokenResp.data.access_token;
        const meResp = await axios.get("https://graph.microsoft.com/v1.0/me", {
          headers: { Authorization: `Bearer ${msAccessToken}` },
        });
        const email: string = meResp.data.mail ?? meResp.data.userPrincipalName ?? "";
        const name: string = meResp.data.displayName ?? email;
        const sessionToken = signSession(email, name);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(pageSuccess(name, sessionToken));
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Erro desconhecido";
        res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
        res.end(pageError(`Falha ao trocar código por token: ${msg}`));
      }
      return;
    }

    // ── Rotas protegidas — exigem token de sessão Microsoft ────────────────────
    const authHeader = req.headers["authorization"] ?? "";
    const sessionToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!verifySession(sessionToken)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized", loginUrl: `${SERVER_BASE_URL}/` }));
      return;
    }

    if (req.method === "GET" && path === "/sse") {
      if (sseTransport) {
        try { await server.close(); } catch { /* ignore */ }
      }
      sseTransport = new SSEServerTransport("/message", res);
      await server.connect(sseTransport);
    } else if (req.method === "POST" && path.startsWith("/message")) {
      if (sseTransport) {
        await sseTransport.handlePostMessage(req, res);
      } else {
        res.writeHead(503, { "Content-Type": "text/plain" });
        res.end("No active SSE session");
      }
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  httpServer.listen(PORT, () => {
    process.stderr.write(`[make-mcp] SSE server listening on port ${PORT}\n`);
  });
} else {
  // stdio mode — usado localmente (Claude Code, etc.)
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
