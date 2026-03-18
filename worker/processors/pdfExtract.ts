import fs from 'fs';
import path from 'path';

export async function extractText(filePath: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.txt' || ext === '.md') {
    return fs.readFileSync(filePath, 'utf-8');
  }

  if (ext === '.csv') {
    return fs.readFileSync(filePath, 'utf-8');
  }

  if (ext === '.xlsx' || ext === '.xls') {
    return extractTextFromExcel(filePath);
  }

  if (ext === '.pdf') {
    return extractTextFromPdf(filePath);
  }

  throw new Error(`Unsupported file type: ${ext}`);
}

async function extractTextFromExcel(filePath: string): Promise<string> {
  const mod = await import('xlsx');
  const XLSX = mod.default || mod;
  const workbook = XLSX.readFile(filePath);
  const lines: string[] = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (workbook.SheetNames.length > 1) {
      lines.push(`--- Sheet: ${sheetName} ---`);
    }
    const csv = XLSX.utils.sheet_to_csv(sheet);
    lines.push(csv);
  }

  return lines.join('\n');
}

async function extractTextFromPdf(filePath: string): Promise<string> {
  // Dynamic import for pdf-parse (CommonJS module)
  const pdfParse = (await import('pdf-parse')).default;
  const dataBuffer = fs.readFileSync(filePath);
  const data = await pdfParse(dataBuffer);

  if (!data.text || data.text.trim().length < 50) {
    throw new Error('PDF appears to be image-only or contains too little text. OCR is not available.');
  }

  return data.text;
}
