// Captures d'écran de preuve : l'image arrive en base64 (data URL) depuis le navigateur, qui l'a déjà réduite.
// Le serveur ne fait confiance ni au type annoncé ni à l'extension : il lit les premiers octets du fichier.
import { HttpError } from './http.js';

export const MAX_IMAGE_BYTES = 600_000;          // après décodage ; le navigateur envoie en général 100 à 250 Ko
export const MAX_PROOF_BODY = 900_000;           // corps JSON (base64 = 4/3 de l'image)

const SIGNATURES = [
  { mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/png', test: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/webp', test: (b) => b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' }
];

/** Renvoie { mime, buf } ou lève une erreur 400. */
export function parseImage(input) {
  if (typeof input !== 'string') throw new HttpError(400, 'invalid_input', 'Image manquante');
  const m = /^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/=\s]+)$/.exec(input);
  if (!m) throw new HttpError(400, 'invalid_input', 'Image invalide (JPEG, PNG ou WebP)');
  const buf = Buffer.from(m[1].replace(/\s/g, ''), 'base64');
  if (!buf.length) throw new HttpError(400, 'invalid_input', 'Image vide');
  if (buf.length > MAX_IMAGE_BYTES) throw new HttpError(413, 'too_large', 'Image trop lourde : prenez une capture plus petite');
  const sig = SIGNATURES.find((s) => s.test(buf));
  if (!sig) throw new HttpError(400, 'invalid_input', 'Le fichier n\'est pas une image valide');
  return { mime: sig.mime, buf };
}
