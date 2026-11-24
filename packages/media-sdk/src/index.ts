// A médiaszerver tokenje (SPEC 1.–4.; terv 4.1–4.4, implementációs terv WP1).
// Tiszta TS, futásidejű függőség nélkül (`node:crypto`); a közös vektorok: `@chromygabor/media-sdk/test-vectors.json`.

export {
  appLookupFrom,
  base64url,
  buildSignedPath,
  parseSignedPath,
  signToken,
  timingSafeEqualStr,
  verifySignedPath,
} from './token.js';
export type {
  AppKeys,
  AppLookup,
  BuildSignedPathInput,
  ParseError,
  ParsedSignedPath,
  SignTokenInput,
  TokenParams,
  VerifyFailureReason,
  VerifyResult,
} from './token.js';
export {
  CONTENT_DIR,
  CONTENT_FILE_EXT,
  CONTENT_FILE_TYPE,
  MEDIA_CONTENT_TYPES,
  classifyMediaPath,
  isPrefixOf,
  isSafeMediaPath,
  isSafeSegment,
  isSafeTokenPath,
} from './path.js';
export type { MediaKind, MediaPathInfo } from './path.js';
export { KEY_ID_RE, KEY_RE, isValidKey, isValidKeyId } from './keys.js';
export { CONTENT_TOKEN_TTL_SECONDS, MEDIA_URL_VERSION_LENGTH, createUrlSigner } from './signer.js';
export type {
  SignAsset,
  SignDirectoryInput,
  SignDirectoryOutput,
  SignRefusal,
  SignResult,
  UrlSigner,
  UrlSignerConfig,
} from './signer.js';
export { bucketExpires } from './expires.js';
export type { BucketOptions } from './expires.js';
