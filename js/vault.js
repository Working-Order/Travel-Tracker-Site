// Travel Tracker document vault.
//
// End-to-end encryption for the handful of fields that identify a person: a
// passport number, a Known Traveler Number, a visa document number, a policy
// number. Firestore only ever receives ciphertext for these, so a leak of the
// database does not leak the identifiers.
//
// Key material lives in this module's scope and is never returned across the
// interop boundary. Blazor asks this module to seal or open a string; it never
// holds a key, which keeps raw key bytes out of managed memory where they could
// be caught by a serializer or a crash dump.
//
// Scheme
// ------
//   stretched = PBKDF2-SHA256(password, salt = SHA-256("traveltracker:v1:" + email), 600k)
//   authSecret = HKDF(stretched, info "auth")   -> sent to Firebase as the password
//   wrapKey    = HKDF(stretched, info "wrap")   -> never leaves the browser
//
// Firebase therefore only ever sees authSecret. Because HKDF is one-way and
// the two labels differ, holding authSecret does not yield wrapKey.
//
// Data is encrypted under a random 256-bit DEK, not under wrapKey directly.
// The DEK is stored twice, wrapped by wrapKey and wrapped by a recovery code.
// That is what makes a password change cheap (re-wrap one small key) and a
// forgotten password survivable (unwrap with the recovery code).

const PBKDF2_ITERATIONS = 600000;
const SALT_PREFIX = "traveltracker:v1:";
const GCM_NONCE_BYTES = 12;

// Crockford base32 minus the characters people misread. A 24-character code
// from this alphabet carries ~110 bits, well beyond what wraps a 256-bit key.
const RECOVERY_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ0123456789";
const RECOVERY_LENGTH = 24;

// Unlocked keys for the current session only. Cleared on lock and on sign-out,
// and never written to storage of any kind.
//
// dekBytes is kept alongside the CryptoKey because a password change has to
// re-wrap the DEK, and an AES-GCM key imported as non-extractable cannot be
// exported back out. The bytes are already resident either way.
let dek = null;
let dekBytes = null;
let wrapKey = null;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64(bytes) {
    let binary = "";
    const view = new Uint8Array(bytes);
    for (let i = 0; i < view.length; i++) {
        binary += String.fromCharCode(view[i]);
    }
    return btoa(binary);
}

function fromBase64(text) {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

/** Deterministic per-account salt, so the same password always stretches the same way. */
async function saltFor(email) {
    const normalized = (email || "").trim().toLowerCase();
    const digest = await crypto.subtle.digest("SHA-256", encoder.encode(SALT_PREFIX + normalized));
    return new Uint8Array(digest);
}

/** The expensive step. One PBKDF2 pass, then cheap HKDF splits off each purpose. */
async function stretch(password, email) {
    const material = await crypto.subtle.importKey(
        "raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);

    const bits = await crypto.subtle.deriveBits(
        { name: "PBKDF2", salt: await saltFor(email), iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
        material,
        256);

    return crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveBits", "deriveKey"]);
}

/** Splits the stretched secret into one purpose-specific value. */
async function branch(stretched, label, asKey) {
    const params = {
        name: "HKDF",
        hash: "SHA-256",
        salt: new Uint8Array(32),
        info: encoder.encode(label),
    };

    if (asKey) {
        return crypto.subtle.deriveKey(
            params, stretched, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    }

    return crypto.subtle.deriveBits(params, stretched, 256);
}

async function keyFromRecoveryCode(code) {
    const cleaned = (code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const material = await crypto.subtle.importKey(
        "raw", encoder.encode(cleaned), "PBKDF2", false, ["deriveBits"]);

    const bits = await crypto.subtle.deriveBits(
        {
            name: "PBKDF2",
            salt: encoder.encode(SALT_PREFIX + "recovery"),
            iterations: PBKDF2_ITERATIONS,
            hash: "SHA-256",
        },
        material,
        256);

    return crypto.subtle.importKey("raw", bits, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** AES-GCM with a fresh nonce each time, stored as nonce || ciphertext || tag. */
async function seal(key, bytes) {
    const nonce = crypto.getRandomValues(new Uint8Array(GCM_NONCE_BYTES));
    const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, bytes);

    const combined = new Uint8Array(nonce.length + sealed.byteLength);
    combined.set(nonce, 0);
    combined.set(new Uint8Array(sealed), nonce.length);
    return toBase64(combined);
}

async function open(key, payload) {
    const combined = fromBase64(payload);
    const nonce = combined.slice(0, GCM_NONCE_BYTES);
    const body = combined.slice(GCM_NONCE_BYTES);

    // Throws on a wrong key or a tampered payload; GCM authenticates for us.
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, body);
    return new Uint8Array(plain);
}

export function isSupported() {
    return typeof crypto !== "undefined" && !!crypto.subtle;
}

/** True when the vault is open and sensitive fields can be read this session. */
export function isUnlocked() {
    return dek !== null;
}

/**
 * Derives the value Firebase should receive as the password. Callers use this
 * instead of the raw password once the account has been upgraded, so the raw
 * password never reaches Google.
 */
export async function deriveAuthSecret(password, email) {
    const stretched = await stretch(password, email);
    return toBase64(await branch(stretched, "auth", false));
}

export function generateRecoveryCode() {
    const raw = crypto.getRandomValues(new Uint8Array(RECOVERY_LENGTH));
    let code = "";
    for (let i = 0; i < RECOVERY_LENGTH; i++) {
        code += RECOVERY_ALPHABET[raw[i] % RECOVERY_ALPHABET.length];
        // Grouped for legibility; the parser strips the dashes again.
        if (i % 6 === 5 && i !== RECOVERY_LENGTH - 1) {
            code += "-";
        }
    }
    return code;
}

/**
 * Creates a vault: a fresh DEK wrapped by the password key and by a recovery
 * code. Returns the wrapped blobs to store and the recovery code to show once.
 * Leaves the vault unlocked, since the caller is about to write to it.
 */
export async function create(password, email) {
    const stretched = await stretch(password, email);
    wrapKey = await branch(stretched, "wrap", true);

    const freshDek = crypto.getRandomValues(new Uint8Array(32));
    const recoveryCode = generateRecoveryCode();
    const recoveryKey = await keyFromRecoveryCode(recoveryCode);

    const result = {
        wrappedByPassword: await seal(wrapKey, freshDek),
        wrappedByRecovery: await seal(recoveryKey, freshDek),
        authSecret: toBase64(await branch(stretched, "auth", false)),
        recoveryCode,
    };

    await adoptDek(freshDek);
    return result;
}

/** Opens the vault with the account password. Returns false on a wrong password. */
export async function unlock(password, email, wrappedByPassword) {
    try {
        const stretched = await stretch(password, email);
        wrapKey = await branch(stretched, "wrap", true);

        await adoptDek(await open(wrapKey, wrappedByPassword));
        return true;
    } catch {
        lock();
        return false;
    }
}

/** Opens the vault with the recovery code, for when the password is lost. */
export async function unlockWithRecoveryCode(recoveryCode, wrappedByRecovery) {
    try {
        const recoveryKey = await keyFromRecoveryCode(recoveryCode);
        await adoptDek(await open(recoveryKey, wrappedByRecovery));
        return true;
    } catch {
        lock();
        return false;
    }
}

/**
 * Re-wraps the open DEK under a new password, and mints a fresh recovery code
 * so the old one stops working. The encrypted fields are untouched, which is
 * what makes a password change instant rather than a re-encryption of
 * everything the traveller has stored.
 */
export async function rewrap(newPassword, email) {
    if (!dekBytes) {
        return null;
    }

    const stretched = await stretch(newPassword, email);
    wrapKey = await branch(stretched, "wrap", true);

    const recoveryCode = generateRecoveryCode();
    const recoveryKey = await keyFromRecoveryCode(recoveryCode);

    return {
        wrappedByPassword: await seal(wrapKey, dekBytes),
        wrappedByRecovery: await seal(recoveryKey, dekBytes),
        authSecret: toBase64(await branch(stretched, "auth", false)),
        recoveryCode,
    };
}

async function adoptDek(raw) {
    dekBytes = new Uint8Array(raw);
    dek = await crypto.subtle.importKey(
        "raw", dekBytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export function lock() {
    // Overwrite before dropping the reference. Not a guarantee under a
    // compacting GC, but it costs nothing and shortens the window.
    if (dekBytes) {
        dekBytes.fill(0);
    }

    dek = null;
    dekBytes = null;
    wrapKey = null;
}

/** Seals one field value. Returns null when the vault is locked. */
export async function encryptValue(plaintext) {
    if (!dek || plaintext === null || plaintext === undefined || plaintext === "") {
        return null;
    }
    return seal(dek, encoder.encode(plaintext));
}

/**
 * Opens one field value. Returns null rather than throwing when the vault is
 * locked or the payload does not belong to this key, so a mixed list of
 * records renders instead of blowing up the page.
 */
export async function decryptValue(ciphertext) {
    if (!dek || !ciphertext) {
        return null;
    }

    try {
        return decoder.decode(await open(dek, ciphertext));
    } catch {
        return null;
    }
}
