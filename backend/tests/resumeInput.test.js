const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');

const {
  extractResumeText,
  resolveResumeFileType,
  ResumeFileError,
  MAX_RESUME_FILE_BYTES,
} = require('../src/services/resumeTextExtractor');
const { normalizeResumeInput, ResumeInputError } = require('../src/services/resumeInputService');
const { generateInterviewPrep } = require('../src/controllers/interviewPrepController');
const app = require('../src/server');

const RESUME_TEXT = [
  'Sudhanshu Rao',
  'Backend Engineer',
  'Projects',
  'LibVerse - a library management platform built with Node.js, Express and MongoDB.',
  'Implemented JWT authentication with refresh tokens and role-based access control.',
  'Experience',
  'Worked on backend services and REST APIs; skills: Node.js, Express, MongoDB, Docker, React.',
].join('\n');

// A minimal but structurally real PDF: header + objects + a FlateDecode content
// stream whose text is recovered by the bounded extractor.
const buildPdf = (lines = [
  'LibVerse library management platform built with Node.js and MongoDB.',
  'Implemented JWT authentication and role-based access control for 300 users.',
  'Skills include Express, Docker and React for the internal admin dashboard.',
]) => {
  const escape = (value) => value.replace(/([()\\])/g, '\\$1');
  const content = ['BT', '/F1 12 Tf', '14 TL', ...lines.map((line) => `(${escape(line)}) Tj T*`), 'ET'].join('\n');
  const compressed = zlib.deflateSync(Buffer.from(content, 'latin1'));
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n',
    `4 0 obj\n<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n${compressed.toString('latin1')}\nendstream\nendobj\n`,
  ];
  return Buffer.from(`%PDF-1.4\n${objects.join('')}trailer\n<< /Root 1 0 R >>\n%%EOF\n`, 'latin1');
};

const mockResponse = () => {
  const res = { statusCode: 200, body: undefined };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
};

const withConsoleCapture = (run) => {
  const lines = [];
  const originals = { log: console.log, error: console.error, warn: console.warn };
  const record = (...values) => lines.push(values.map((value) => (typeof value === 'string' ? value : JSON.stringify(value))).join(' '));
  console.log = record;
  console.error = record;
  console.warn = record;
  try {
    return { result: run(), logs: lines };
  } finally {
    console.log = originals.log;
    console.error = originals.error;
    console.warn = originals.warn;
  }
};

const expectCode = (operation, code) =>
  assert.throws(operation, (error) => {
    assert.equal(error.code, code);
    return true;
  });

describe('resume file validation and text extraction', () => {
  it('parses a supported text resume and returns sanitized, readable text', () => {
    const result = extractResumeText({
      buffer: Buffer.from(RESUME_TEXT, 'utf8'),
      fileName: 'resume.txt',
      mimeType: 'text/plain',
    });
    assert.equal(result.fileType, 'text');
    assert.ok(result.text.includes('LibVerse'));
    assert.ok(result.text.includes('JWT authentication'));
    assert.equal(result.text.includes('\u0000'), false);
  });

  it('parses a supported PDF resume without adding a dependency', () => {
    const result = extractResumeText({ buffer: buildPdf(), fileName: 'cv.pdf', mimeType: 'application/pdf' });
    assert.equal(result.fileType, 'pdf');
    assert.ok(result.text.includes('LibVerse'), result.text);
    assert.ok(result.text.includes('JWT authentication'), result.text);
    assert.ok(result.text.includes('MongoDB'), result.text);
  });

  it('resolves the file type from the extension or the media type', () => {
    assert.equal(resolveResumeFileType({ fileName: 'CV.PDF' }), 'pdf');
    assert.equal(resolveResumeFileType({ fileName: 'resume.markdown' }), 'text');
    assert.equal(resolveResumeFileType({ fileName: 'resume', mimeType: 'text/plain' }), 'text');
    // Browsers may send a generic type; the extension decides.
    assert.equal(resolveResumeFileType({ fileName: 'resume.pdf', mimeType: 'application/octet-stream' }), 'pdf');
  });

  it('rejects unsupported file types with a stable public error code', () => {
    for (const fileName of ['resume.docx', 'resume.exe', 'resume.png', 'resume']) {
      expectCode(() => resolveResumeFileType({ fileName, mimeType: '' }), 'RESUME_UNSUPPORTED_FILE_TYPE');
    }
    expectCode(
      () => resolveResumeFileType({
        fileName: 'resume.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
      'RESUME_UNSUPPORTED_FILE_TYPE'
    );
  });

  it('rejects a file whose extension and media type disagree', () => {
    expectCode(() => resolveResumeFileType({ fileName: 'resume.pdf', mimeType: 'text/plain' }), 'RESUME_FILE_TYPE_MISMATCH');
  });

  it('rejects a file whose content does not match its declared type', () => {
    expectCode(
      () => extractResumeText({ buffer: Buffer.from(RESUME_TEXT, 'utf8'), fileName: 'resume.pdf', mimeType: 'application/pdf' }),
      'RESUME_INVALID_FILE'
    );
    expectCode(
      () => extractResumeText({ buffer: Buffer.from([0x00, 0x01, 0x02, 0x03]), fileName: 'resume.txt', mimeType: 'text/plain' }),
      'RESUME_INVALID_FILE'
    );
  });

  it('rejects an oversized file before any parsing work', () => {
    const oversized = Buffer.alloc(MAX_RESUME_FILE_BYTES + 1024, 0x41);
    expectCode(() => extractResumeText({ buffer: oversized, fileName: 'resume.txt', mimeType: 'text/plain' }), 'RESUME_FILE_TOO_LARGE');
  });

  it('rejects unreadable and encrypted PDFs instead of returning garbage', () => {
    expectCode(() => extractResumeText({ buffer: buildPdf(['   ']), fileName: 'empty.pdf', mimeType: 'application/pdf' }), 'RESUME_NO_TEXT');
    const encrypted = Buffer.concat([Buffer.from('%PDF-1.4\n/Encrypt 9 0 R\n', 'latin1'), buildPdf()]);
    expectCode(() => extractResumeText({ buffer: encrypted, fileName: 'locked.pdf', mimeType: 'application/pdf' }), 'RESUME_ENCRYPTED_PDF');
  });

  it('never logs or exposes the resume content', () => {
    const { logs } = withConsoleCapture(() => {
      extractResumeText({ buffer: Buffer.from(RESUME_TEXT, 'utf8'), fileName: 'resume.txt', mimeType: 'text/plain' });
      try {
        extractResumeText({ buffer: Buffer.from(RESUME_TEXT, 'utf8'), fileName: 'resume.docx' });
      } catch (error) {
        assert.equal(error.code, 'RESUME_UNSUPPORTED_FILE_TYPE');
      }
      try {
        normalizeResumeInput({ fileName: 'resume.txt', dataBase64: 'not base64!!' });
      } catch (error) {
        assert.equal(error.code, 'RESUME_INVALID_PAYLOAD');
      }
    });
    assert.ok(logs.length === 0, `nothing should be logged: ${JSON.stringify(logs)}`);
    assert.equal(logs.join(' ').includes('LibVerse'), false);
  });

  it('raises public, content-free errors', () => {
    try {
      extractResumeText({ buffer: Buffer.from('short'), fileName: 'resume.txt', mimeType: 'text/plain' });
      assert.fail('expected an error');
    } catch (error) {
      assert.ok(error instanceof ResumeFileError);
      assert.equal(error.isPublic, true);
      assert.equal(error.message.includes('LibVerse'), false);
      assert.equal(/[A-Za-z]:\\|base64|[A-Za-z0-9+/]{40,}/.test(error.message), false, error.message);
    }
  });
});

describe('resume request normalization', () => {
  const baseBody = {
    jobRole: 'Backend Developer',
    jobDescription: 'Backend role with Node.js.',
    companyUrl: 'https://example.com/',
    interviewDays: 5,
  };
  // Valid input starts a background kit job; the fake runner records the job spec.
  const fakeRunner = () => {
    const specs = [];
    return { specs, createJob: async (spec) => { specs.push(spec); return { id: 'job-1' }; } };
  };

  it('treats a missing resume exactly like the existing JD-only request', async () => {
    assert.equal(normalizeResumeInput(undefined), null);
    assert.equal(normalizeResumeInput(null), null);
    const runner = fakeRunner();
    const res = mockResponse();
    await generateInterviewPrep({ body: baseBody }, res, { jobRunner: runner });
    assert.equal(res.statusCode, 202);
    assert.equal(runner.specs[0].input.hasResume, false);
    assert.equal('memoryInput' in runner.specs[0], false, 'the JD-only request must not carry a resume');
  });

  it('accepts pasted text and a validated base64 upload', () => {
    const fromText = normalizeResumeInput({ text: RESUME_TEXT });
    assert.equal(fromText.fileType, 'text');
    assert.equal(fromText.charCount, fromText.text.length);

    const fromUpload = normalizeResumeInput({
      fileName: 'cv.pdf',
      mimeType: 'application/pdf',
      dataBase64: buildPdf().toString('base64'),
    });
    assert.equal(fromUpload.fileType, 'pdf');
    assert.equal(fromUpload.fileName, 'cv.pdf');
    assert.ok(fromUpload.text.includes('LibVerse'));
  });

  it('rejects invalid resume payloads with machine-readable codes', () => {
    expectCode(() => normalizeResumeInput('resume'), 'RESUME_INVALID_PAYLOAD');
    expectCode(() => normalizeResumeInput({}), 'RESUME_INVALID_PAYLOAD');
    expectCode(() => normalizeResumeInput({ text: '   ' }), 'RESUME_INVALID_PAYLOAD');
    expectCode(() => normalizeResumeInput({ text: RESUME_TEXT, fileName: 'cv.docx' }), 'RESUME_UNSUPPORTED_FILE_TYPE');
    expectCode(() => normalizeResumeInput({ fileName: 'cv.txt', dataBase64: '!!!!' }), 'RESUME_INVALID_PAYLOAD');
    expectCode(() => normalizeResumeInput({ fileName: 'cv.docx', dataBase64: Buffer.from('x').toString('base64') }), 'RESUME_UNSUPPORTED_FILE_TYPE');
  });

  it('rejects an oversized upload at the request boundary', () => {
    const huge = Buffer.alloc(MAX_RESUME_FILE_BYTES + 1024, 0x41).toString('base64');
    expectCode(() => normalizeResumeInput({ fileName: 'cv.txt', mimeType: 'text/plain', dataBase64: huge }), 'RESUME_FILE_TOO_LARGE');
  });

  it('maps resume validation failures to safe structured API responses', async () => {
    const res = mockResponse();
    const runner = fakeRunner();
    await generateInterviewPrep(
      { body: { ...baseBody, resume: { fileName: 'resume.docx', dataBase64: Buffer.from('x').toString('base64') } } },
      res,
      { jobRunner: runner }
    );
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error.code, 'RESUME_UNSUPPORTED_FILE_TYPE');
    assert.equal(JSON.stringify(res.body).includes('LibVerse'), false);
    assert.equal(runner.specs.length, 0, 'no job may start for an invalid resume');
  });

  it('hands the normalized resume to the job in memory only, never in the stored input or the response', async () => {
    const res = mockResponse();
    const runner = fakeRunner();
    await generateInterviewPrep({ body: { ...baseBody, resume: { text: RESUME_TEXT } } }, res, { jobRunner: runner });
    assert.equal(res.statusCode, 202);
    const [spec] = runner.specs;
    assert.ok(spec.memoryInput.resume.text.includes('LibVerse'));
    assert.equal(spec.input.hasResume, true);
    assert.equal(JSON.stringify(spec.input).includes('LibVerse'), false, 'the persisted job input must not hold resume text');
    assert.equal(JSON.stringify(res.body).includes('LibVerse'), false, 'raw resume text must not be returned');
  });
});

describe('HTTP body limits', () => {
  const withServer = async (run) => {
    const server = app.listen(0);
    try {
      const { port } = server.address();
      return await run((path, body, headers = {}) =>
        fetch(`http://127.0.0.1:${port}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body,
        })
      );
    } finally {
      server.close();
    }
  };

  it('accepts a resume-sized body on the interview-prep route and rejects an oversized one', async () => {
    await withServer(async (post) => {
      const oneMegabyte = JSON.stringify({ jobRole: 'x', resume: { dataBase64: 'A'.repeat(1_000_000) } });
      const accepted = await post('/api/interview-prep', oneMegabyte);
      assert.equal(accepted.status, 401, 'the body was parsed and the request reached authentication');

      const oversized = JSON.stringify({ jobRole: 'x', resume: { dataBase64: 'A'.repeat(5 * 1024 * 1024) } });
      const rejected = await post('/api/interview-prep', oversized);
      assert.equal(rejected.status, 413);
      assert.equal((await rejected.json()).error.code, 'PAYLOAD_TOO_LARGE');
    });
  });

  it('keeps the shared limit and strict JSON parsing for every other route', async () => {
    await withServer(async (post) => {
      const tooLarge = await post('/api/kits', JSON.stringify({ jobDescription: 'A'.repeat(400_000) }));
      assert.equal(tooLarge.status, 413);

      const malformed = await post('/api/interview-prep', '{not json');
      assert.equal(malformed.status, 400);
      assert.equal((await malformed.json()).error.code, 'INVALID_JSON');
    });
  });
});