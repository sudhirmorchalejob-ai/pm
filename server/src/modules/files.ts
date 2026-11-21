import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { Router } from 'express';
import { config } from '../config';
import { db } from '../db/knex';
import { me } from '../auth/middleware';
import { loadVisibleProject, loadVisibleTask } from '../auth/scope';
import { badRequest, notFound } from '../lib/errors';
import { idParam } from '../lib/http';

export const uploadDir = path.resolve(config.UPLOAD_DIR);
fs.mkdirSync(uploadDir, { recursive: true });

// Allow common office/document/image/archive types only. Executables & HTML are rejected.
const ALLOWED = new Map<string, string[]>([
  ['application/pdf', ['.pdf']],
  ['image/png', ['.png']], ['image/jpeg', ['.jpg', '.jpeg']], ['image/gif', ['.gif']], ['image/webp', ['.webp']],
  ['text/plain', ['.txt', '.log', '.md']], ['text/csv', ['.csv']],
  ['application/msword', ['.doc']], ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', ['.docx']],
  ['application/vnd.ms-excel', ['.xls']], ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ['.xlsx']],
  ['application/vnd.ms-powerpoint', ['.ppt']], ['application/vnd.openxmlformats-officedocument.presentationml.presentation', ['.pptx']],
  ['application/zip', ['.zip']], ['application/x-zip-compressed', ['.zip']], ['application/json', ['.json']],
]);

// Magic-byte check for the binary types where spoofing matters most.
const MAGIC: Record<string, number[]> = {
  '.pdf': [0x25, 0x50, 0x44, 0x46], '.png': [0x89, 0x50, 0x4e, 0x47], '.jpg': [0xff, 0xd8, 0xff], '.jpeg': [0xff, 0xd8, 0xff],
  '.gif': [0x47, 0x49, 0x46], '.zip': [0x50, 0x4b], '.docx': [0x50, 0x4b], '.xlsx': [0x50, 0x4b], '.pptx': [0x50, 0x4b],
};

export const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (_req, _file, cb) => cb(null, crypto.randomBytes(16).toString('hex')),
  }),
  limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024, files: 10 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const okExt = ALLOWED.get(file.mimetype);
    if (!okExt || !okExt.includes(ext)) return cb(badRequest(`File type not allowed: ${file.originalname}`));
    cb(null, true);
  },
});

/** Verify magic bytes, hash, and register the uploaded file. Deletes the file on rejection. */
export async function registerFile(f: Express.Multer.File, userId: number) {
  const full = path.join(uploadDir, f.filename);
  const buf = fs.readFileSync(full);
  const ext = path.extname(f.originalname).toLowerCase();
  const magic = MAGIC[ext];
  if (magic && !magic.every((b, i) => buf[i] === b)) {
    fs.unlinkSync(full);
    throw badRequest(`File content does not match its type: ${f.originalname}`);
  }
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const [row] = await db('files').insert({
    original_name: path.basename(f.originalname).slice(0, 255), stored_name: f.filename, mime_type: f.mimetype, size_bytes: f.size,
    sha256, uploaded_by: userId,
  }).returning('*');
  return row;
}

export const router = Router();

/** Download with authorization: the file must be attached to a task/project the user can see. */
router.get('/:id/download', async (req, res) => {
  const id = idParam(req);
  const file = await db('files').where({ id }).first();
  if (!file) throw notFound();
  const u = me(req);
  const ta = await db('task_attachments').where({ file_id: id }).first('task_id');
  const pd = await db('project_documents').where({ file_id: id }).first('project_id');
  if (ta) await loadVisibleTask(u, ta.task_id);
  else if (pd) await loadVisibleProject(u, pd.project_id);
  else if (file.uploaded_by !== u.id) throw notFound();
  res.setHeader('Content-Type', file.mime_type);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.original_name)}"`);
  res.sendFile(path.join(uploadDir, file.stored_name));
});
