/**
 * Hashing with no Node APIs, so the same buckets come out on the server, in Convex functions
 * and in a browser.
 */
/** SHA-256 of a string's UTF-8 bytes, as lowercase hex. */
export declare function sha256(input: string): string;
/**
 * Deterministic bucket in [0, 1) for a key: the first 32 bits of its SHA-256. A session keeps
 * its side of a trial, a trace its judge sample and an item its dataset split, on the server,
 * in Convex functions and in a browser alike.
 */
export declare function bucket(key: string): number;
/** JSON with sorted keys, so equal content always compares (and hashes) the same. */
export declare function canonicalJson(value: unknown): string;
/** SHA-256 of the canonical JSON: a version's content hash, so storing the same content twice finds the first. */
export declare function contentHash(value: unknown): string;
