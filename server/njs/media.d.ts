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
  origins?: string[];
  corp?: string;
}

/** Az njs kérés-objektumának a modul által használt része. */
export interface NjsRequest {
  variables: { request_uri: string; request_id: string };
  headersIn: Record<string, string | undefined>;
  headersOut?: Record<string, string | undefined>;
  return?(status: number, body?: string): void;
}

declare const media: {
  status(r: NjsRequest): string;
  reason(r: NjsRequest): string;
  file(r: NjsRequest): string;
  app(r: NjsRequest): string;
  kid(r: NjsRequest): string;
  user(r: NjsRequest): string;
  userKey(r: NjsRequest): string;
  path(r: NjsRequest): string;
  cache(r: NjsRequest): string;
  corp(r: NjsRequest): string;
  corsOrigin(r: NjsRequest): string;
  denied(r: NjsRequest): void;
  verify(rawRequestUri: string, apps: Readonly<Record<string, AppConfig>>, now: number): VerifyResult;
  validateApps(apps: unknown): string[];
  plainPath(rawRequestUri: string): string;
  MEDIA_CONTENT_TYPES: Readonly<Record<string, string>>;
};
export default media;
