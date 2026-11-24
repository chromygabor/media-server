// Típusok a media.js-hez (csak a Node-os tesztekhez és a typecheckhez; az nginx nem olvassa).

export type VerifyResult =
  | {
      ok: true;
      app: string;
      kid: string;
      u: string | undefined;
      path: string;
      assetKey: string;
      kind: 'browser' | 'content';
      contentType: string;
    }
  | { ok: false; status: 403 | 404 | 410; reason: string };

export interface AppConfig {
  dir?: string;
  keys?: Record<string, string>;
  contentKeys?: Record<string, string>;
  /** ES256 böngészős nyilvános kulcsok (elhagyható). */
  publicKeys?: Record<string, string>;
  /** ES256 tartalom-nyilvános kulcsok (elhagyható). */
  contentPublicKeys?: Record<string, string>;
  origins?: string[];
  corp?: string;
}

/** A kapu `js_var`-jai (media.conf) és az olvasott nginx-változók. */
export interface NjsVariables {
  request_uri: string;
  remote_addr?: string;
  media_status?: string;
  media_reason?: string;
  media_file?: string;
  media_app?: string;
  media_kid?: string;
  media_u?: string;
  media_user_key?: string;
  media_kind?: string;
}

/** Az njs kérés-objektumának a modul által használt része. */
export interface NjsRequest {
  variables: NjsVariables;
  headersIn: Record<string, string | undefined>;
  headersOut?: Record<string, string | undefined>;
  /** A válasz állapota (js_header_filter). */
  status?: number;
  return?(status: number, body?: string): void;
  internalRedirect?(location: string): void;
}

/** Az `ngx.shared.<zóna>` (js_shared_dict_zone, `type=number`) általunk használt része. */
export interface NjsSharedDict {
  get(key: string): number | undefined;
  incr(key: string, delta: number, init?: number, timeout?: number): number;
}

declare const media: {
  /** A fő location kapuja (js_content, aszinkron). */
  gate(r: NjsRequest): Promise<void>;
  denied(r: NjsRequest): void;
  path(r: NjsRequest): string;
  headers(r: NjsRequest): void;
  cache(r: NjsRequest): string;
  corp(r: NjsRequest): string;
  corsOrigin(r: NjsRequest): string;
  /** Aszinkron; a Promise nem utasít el (a belső hiba `403 internal-error`). */
  verify(rawRequestUri: string, apps: Readonly<Record<string, AppConfig>>, now: number): Promise<VerifyResult>;
  validateApps(apps: unknown): string[];
  plainPath(rawRequestUri: string): string;
  /** `r ‖ s` (64 bájt): `s ≤ n/2`. */
  isLowS(sig: Uint8Array): boolean;
  MEDIA_CONTENT_TYPES: Readonly<Record<string, string>>;
  FAILS_LIMIT: number;
  FAILS_WINDOW_MS: number;
};
export default media;
