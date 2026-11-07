/**
 * Clean interface for an optional connection to a running Odoo instance. Nothing in the
 * extension core depends on this being connected — runtime data is an enhancement layer that,
 * when present, is displayed alongside (and can override) static-index facts, with the source
 * of each fact always labeled (see RuntimeRegistryPanel).
 *
 * OdooLens ships no direct XML-RPC/JSON-RPC client wired to arbitrary Odoo servers by default,
 * because introspecting `ir.model`/`ir.model.fields` safely and efficiently is easiest with a
 * small trusted server-side helper controller. `JsonRpcRuntimeProvider` below is a reference
 * implementation for such a setup (a single authenticated JSON endpoint you control), while
 * still satisfying the `OdooRuntimeProvider` contract so other transports can be dropped in.
 */
export interface OdooRuntimeModelInfo {
  name: string;
  fields: string[];
  methods: string[];
  inheritedModules: string[];
}

export interface OdooRuntimeFieldInfo {
  name: string;
  type: string;
  comodel?: string;
  store: boolean;
  present: true;
}

export interface OdooRuntimeViewInfo {
  id: number;
  name: string;
  type: string;
}

export interface OdooRuntimeConnectionConfig {
  serverUrl: string;
  database: string;
  /** Never logged or persisted outside VS Code SecretStorage. */
  authTokenSecretKey: string;
}

export interface OdooRuntimeProvider {
  connect(config: OdooRuntimeConnectionConfig, secretToken: string): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  getModels(): Promise<string[]>;
  getModel(name: string): Promise<OdooRuntimeModelInfo | null>;
  getField(model: string, field: string): Promise<OdooRuntimeFieldInfo | null>;
  getViews(model: string): Promise<OdooRuntimeViewInfo[]>;
}

/**
 * Reference implementation calling a small trusted helper endpoint you control (e.g. a
 * lightweight controller you add to a custom module), rather than raw XML-RPC, so this stays
 * transport-agnostic and easy to secure. Networking is intentionally minimal and has no
 * hard-coded credentials; the token is supplied at connect-time and stored only via
 * VS Code SecretStorage by the caller (see commands/registryInspector.ts).
 */
export class JsonRpcRuntimeProvider implements OdooRuntimeProvider {
  private config: OdooRuntimeConnectionConfig | null = null;
  private token: string | null = null;

  async connect(config: OdooRuntimeConnectionConfig, secretToken: string): Promise<void> {
    this.config = config;
    this.token = secretToken;
    // A real implementation would perform a lightweight auth-check request here. We deliberately
    // avoid making an unsolicited network call as part of this reference implementation; callers
    // that want an eager health check should call getModels() immediately after connect().
  }

  async disconnect(): Promise<void> {
    this.config = null;
    this.token = null;
  }

  isConnected(): boolean {
    return this.config !== null;
  }

  private async call<T>(path: string, body: unknown): Promise<T> {
    if (!this.config || !this.token) throw new Error('OdooLens runtime is not connected.');
    const url = `${this.config.serverUrl.replace(/\/$/, '')}${path}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ database: this.config.database, ...(body as Record<string, unknown>) }),
    });
    if (!res.ok) throw new Error(`Odoo runtime helper returned HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  async getModels(): Promise<string[]> {
    return this.call<string[]>('/odoolens/models', {});
  }
  async getModel(name: string): Promise<OdooRuntimeModelInfo | null> {
    return this.call<OdooRuntimeModelInfo | null>('/odoolens/model', { model: name });
  }
  async getField(model: string, field: string): Promise<OdooRuntimeFieldInfo | null> {
    return this.call<OdooRuntimeFieldInfo | null>('/odoolens/field', { model, field });
  }
  async getViews(model: string): Promise<OdooRuntimeViewInfo[]> {
    return this.call<OdooRuntimeViewInfo[]>('/odoolens/views', { model });
  }
}
