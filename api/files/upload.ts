import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import {
  applyDecorators, ArgumentsHost, Catch, ExceptionFilter, PayloadTooLargeException, UnsupportedMediaTypeException, UseFilters, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { diskStorage } from 'multer';
import { hasBlockedExtension, megabyte } from './rules';
import { temporaryFolder } from './storage';

export const blockedFileMessage = 'Arquivos executáveis não são aceitos.';

@Catch(PayloadTooLargeException)
class UploadLimitFilter implements ExceptionFilter {
  constructor(private maxBytes: number) {}

  catch(_error: PayloadTooLargeException, host: ArgumentsHost) {
    host.switchToHttp().getResponse<Response>().status(413).json({ message: 'O arquivo passa do limite de ' + Math.round(this.maxBytes / megabyte) + ' MB.' });
  }
}

/** Receives one file in the "file" field, straight to a temporary file with a generated name. */
export const FileUpload = (maxBytes: number, accepted?: { name: (name: string) => boolean; message: string }) => applyDecorators(
  UseFilters(new UploadLimitFilter(maxBytes)),
  UseInterceptors(FileInterceptor('file', {
    storage: diskStorage({
      destination: (_request, _file, done) => {
        // Read on each request, so a missing configuration answers with a clear error instead of stopping the API.
        Promise.resolve().then(async () => {
          const folder = temporaryFolder();
          await mkdir(folder, { recursive: true });
          done(null, folder);
        }).catch(error => done(error as Error, ''));
      },
      filename: (_request, _file, done) => done(null, randomUUID() + '.part'),
    }),
    limits: { fileSize: maxBytes, files: 1 },
    defParamCharset: 'utf8',
    fileFilter: (_request, file, done) => {
      if (hasBlockedExtension(file.originalname)) done(new UnsupportedMediaTypeException(blockedFileMessage), false);
      else if (accepted && !accepted.name(file.originalname)) done(new UnsupportedMediaTypeException(accepted.message), false);
      else done(null, true);
    },
  })),
);
