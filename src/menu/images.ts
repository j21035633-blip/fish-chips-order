import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { basename, extname, join } from "node:path";

import multer from "multer";

import { config } from "../config/env.js";
import { MenuValidationError } from "./types.js";

/**
 * Uploaded images, on the local filesystem.
 *
 * Two callers share this: menu-item photos, and the screenshots customers
 * submit as proof of a review or a share. Same limits, same naming, same
 * volume — they differ only by the subdirectory they land in.
 *
 * Files are written under `config.uploadsDir` (default: `uploads` beside the
 * working directory) and served read-only at `/uploads/...`. `image_url` on the
 * item holds the served path, not the disk path, so moving the directory does
 * not rewrite the menu.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RAILWAY — MANUAL STEP, NOT DONE IN CODE
 *
 * A container filesystem is wiped on every redeploy. For uploaded images to
 * survive one, attach a **persistent volume mounted at `/app/uploads`** to the
 * service, in the Railway dashboard (Service → Settings → Volumes) — the same
 * pattern as the volume behind the MongoDB service.
 *
 * Nothing here can create that for you, and nothing here checks for it: a
 * missing volume looks exactly like a working directory until the next deploy,
 * when every `image_url` starts 404ing while the menu still lists the items.
 * Railway's working directory is `/app`, so the default resolves to
 * `/app/uploads` with no configuration; set `UPLOADS_DIR` only if the volume is
 * mounted somewhere else.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** The subdirectories under the uploads root, one per kind of upload. */
export const MENU_IMAGES = "menu-items";
export const PROOF_IMAGES = "proofs";

export type ImageKind = typeof MENU_IMAGES | typeof PROOF_IMAGES;

/** 5 MB. A phone photo of a plate of fish clears this comfortably. */
const MAX_BYTES = 5 * 1024 * 1024;

/**
 * Raster formats only.
 *
 * SVG is deliberately absent: it can carry script, and these files are served
 * from the same origin as the customer app and the staff pages.
 */
const ALLOWED = new Map([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
  ["image/gif", ".gif"],
  ["image/avif", ".avif"],
]);

export function imageDir(kind: ImageKind = MENU_IMAGES): string {
  return join(config.uploadsDir, kind);
}

/** Multer, configured for one optional image field named `image`. */
export function imageUpload(kind: ImageKind = MENU_IMAGES): multer.Multer {
  const storage = multer.diskStorage({
    destination(_req, _file, done) {
      const dir = imageDir(kind);
      // Created on demand rather than at boot: the volume may be mounted after
      // the process starts, and an upload is the first time we actually need it.
      try {
        mkdirSync(dir, { recursive: true });
        done(null, dir);
      } catch (error) {
        done(error as Error, dir);
      }
    },
    filename(_req, file, done) {
      // The uploaded name is never reused: it is attacker-controlled, may collide
      // with an existing file, and may not be a safe path segment.
      done(null, `${randomUUID()}${ALLOWED.get(file.mimetype) ?? extname(file.originalname).toLowerCase()}`);
    },
  });

  return multer({
    storage,
    limits: { fileSize: MAX_BYTES, files: 1, fields: 20 },
    fileFilter(_req, file, done) {
      if (!ALLOWED.has(file.mimetype)) {
        done(
          new MenuValidationError(
            `${file.mimetype} is not an image we accept. Use JPEG, PNG, WebP, GIF or AVIF.`,
            "unsupported_image_type",
            { mimetype: file.mimetype, accepted: [...ALLOWED.keys()] },
          ),
        );
        return;
      }
      done(null, true);
    },
  });
}

/** The path to store on the record, for a file multer has just written. */
export function servedImageUrl(file: { filename: string }, kind: ImageKind = MENU_IMAGES): string {
  return `/uploads/${kind}/${file.filename}`;
}

/**
 * Deletes the file behind an `imageUrl`, best effort.
 *
 * Best effort on purpose: an orphaned file wastes a few hundred kilobytes,
 * whereas failing the request the staff member actually asked for — replacing a
 * photo, deleting an item — over a failed unlink would be worse. Only ever
 * touches names inside the image directory, so a doctored `imageUrl` in the
 * database cannot point the unlink somewhere else.
 */
export async function deleteImage(imageUrl: string | undefined, kind: ImageKind = MENU_IMAGES): Promise<void> {
  if (!imageUrl?.startsWith(`/uploads/${kind}/`)) return;

  const name = basename(imageUrl);
  if (name.length === 0 || name === "." || name === "..") return;

  await unlink(join(imageDir(kind), name)).catch(() => {});
}
