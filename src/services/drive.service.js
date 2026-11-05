import { google } from 'googleapis';
import stream from 'stream';
import path from 'path';
import fs from 'fs';

export async function subirArchivoGoogleDrive(bufferArchivo, nombreArchivo) {
  const credentialsPath = path.resolve(process.cwd(), 'google-credentials.json');

  if (!fs.existsSync(credentialsPath)) {
    throw new Error('No se encontró el archivo google-credentials.json en la raíz del proyecto.');
  }

  const auth = new google.auth.GoogleAuth({
    keyFile: credentialsPath,
    scopes: ['https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/drive']
  });

  const drive = google.drive({ version: 'v3', auth });

  const bufferStream = new stream.PassThrough();
  bufferStream.end(bufferArchivo);

  const fileMetadata = {
    name: nombreArchivo,
    mimeType: 'text/csv'
  };

  const media = {
    mimeType: 'text/csv',
    body: bufferStream
  };

  const response = await drive.files.create({
    requestBody: fileMetadata,
    media: media,
    fields: 'id, name, webViewLink'
  });

  return response.data;
}
