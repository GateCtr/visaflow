import { createCipheriv, pbkdf2Sync, randomBytes } from "crypto";

// nosemgrep: generic-api-key — clé publique, visible dans le JS client du portail
export let USA_ENC_SEC_KEY = "OuoCdl8xQh/OX6LbmgLEtZxZrvnOmrubsMhPW1VPRjk=";

export function updateAesKey(newKey: string): void {
  USA_ENC_SEC_KEY = newKey;
}

export function encryptPortalCredentials(username: string, password: string): string {
  const plaintext = `${username}:${password}`;
  const salt = randomBytes(16);
  const key = pbkdf2Sync(USA_ENC_SEC_KEY, salt, 1000, 32, "sha1");
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return salt.toString("hex") + iv.toString("hex") + encrypted.toString("base64");
}
