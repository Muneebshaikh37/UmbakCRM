const express = require('express');
const multer = require('multer');
const fetch = require('node-fetch');
const FormData = require('form-data');
const path = require('path');
const fs = require('fs');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const cors = require('cors');

const app = express();

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
    },
  },
}));

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean);
app.use(cors({
  origin: ALLOWED_ORIGINS.length > 0 ? ALLOWED_ORIGINS : false,
  methods: ['GET', 'POST'],
}));

const submitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many submissions. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const upload = multer({ dest: '/tmp/uploads/', limits: { fileSize: 10 * 1024 * 1024 } });

const TWENTY_API_URL = process.env.TWENTY_API_URL || 'http://twenty-server:3000/api';
const TWENTY_API_KEY = process.env.TWENTY_API_KEY;
const PORT = process.env.PORT || 4000;
const BASE_PATH = (process.env.BASE_PATH || '/').replace(/\/+$/, '') || '/';

const FILE_FIELDS = [
  { name: 'docId', maxCount: 1 },
  { name: 'docProofOfBank', maxCount: 1 },
  { name: 'docTradingAddress', maxCount: 1 },
  { name: 'docHomeAddress', maxCount: 1 },
  { name: 'docShopPhotos', maxCount: 5 },
  { name: 'docPaymentStatement', maxCount: 1 },
  { name: 'docMenu', maxCount: 5 },
];

const router = express.Router();
router.use(express.json());

const basePath = BASE_PATH.endsWith('/') ? BASE_PATH : BASE_PATH + '/';
router.get('/', (_req, res) => {
  const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  res.type('html').send(html.replace('<head>', `<head>\n  <base href="${basePath}">`));
});
router.use(express.static(path.join(__dirname, 'public')));

router.get('/health', (_req, res) => res.json({ status: 'ok' }));

router.post('/api/submit', submitLimiter, upload.fields(FILE_FIELDS), async (req, res) => {
  try {
    if (!TWENTY_API_KEY) {
      return res.status(500).json({ error: 'Server not configured' });
    }

    const data = JSON.parse(req.body.formData || '{}');

    if (data.website || data.faxNumber) {
      return res.json({ success: true, companyId: 'ok', personId: 'ok' });
    }
    const companyId = await createCompany(data);
    const personId = await createPerson(data, companyId);
    await createApplicationNote(data, companyId);

    if (req.files) {
      const uploadedFiles = [];
      for (const [fieldName, files] of Object.entries(req.files)) {
        for (const file of files) {
          const label = fileFieldLabel(fieldName);
          const fileRef = await uploadFile(file, label);
          if (fileRef) uploadedFiles.push(fileRef);
        }
      }
      if (uploadedFiles.length > 0) {
        await updateCompanyDocuments(companyId, uploadedFiles);
      }
    }

    cleanupAllFiles(req.files);
    res.json({ success: true, companyId, personId });
  } catch (err) {
    cleanupAllFiles(req.files);
    console.error('Submission error:', err.message);
    res.status(500).json({ error: 'Submission failed. Please try again.' });
  }
});

function fileFieldLabel(fieldName) {
  const labels = {
    docId: 'ID Document',
    docProofOfBank: 'Proof of Bank',
    docTradingAddress: 'Proof of Trading Address',
    docHomeAddress: 'Proof of Home Address',
    docShopPhotos: 'Shop Photos',
    docPaymentStatement: 'Payment/Switcher Statement',
    docMenu: 'Menu/Items/Prices/Logo',
  };
  return labels[fieldName] || fieldName;
}

async function graphql(query, variables, endpoint = 'graphql') {
  const response = await fetch(`${TWENTY_API_URL}/${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TWENTY_API_KEY}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await response.json();
  if (json.errors && json.errors.length > 0) {
    throw new Error(json.errors[0].message);
  }
  return json.data;
}

async function createCompany(data) {
  const result = await graphql(
    `mutation CreateCompany($input: CompanyCreateInput!) {
      createCompany(data: $input) { id }
    }`,
    {
      input: {
        name: data.tradingName || 'Unknown Company',
        domainName: { primaryLinkUrl: '', primaryLinkLabel: data.ltdName || '' },
        address: { addressStreet1: data.businessAddress || '' },
        croNumber: data.croNumber || '',
        vatNumber: data.vatNumber || '',
        industrySector: data.industrySector || '',
        industrySubcategory: data.industrySubcategory || '',
        sellerEmail: data.sellerEmail || '',
        numberOfLocations: data.numberOfLocations || '',
        usersPerLocation: data.usersPerLocation || '',
        hardwareRequirement: data.hardwareRequirement || '',
        paymentProcessing: data.paymentProcessing || '',
        preferredOs: data.preferredOS || '',
        softwareRequirement: data.softwareRequirement || '',
        softwareLicence: data.softwareLicence || '',
        installationCost: data.installationCost || '',
      },
    }
  );
  return result.createCompany.id;
}

async function createPerson(data, companyId) {
  const nameParts = (data.signatoryName || '').trim().split(/\s+/);
  const firstName = nameParts[0] || 'Unknown';
  const lastName = nameParts.slice(1).join(' ') || 'Unknown';

  const result = await graphql(
    `mutation CreatePerson($input: PersonCreateInput!) {
      createPerson(data: $input) { id }
    }`,
    {
      input: {
        name: { firstName, lastName },
        emails: { primaryEmail: data.email || '' },
        phones: {
          primaryPhoneNumber: data.phone || '',
          primaryPhoneCountryCode: 'IE',
          primaryPhoneCallingCode: '+353',
        },
        companyId,
        jobTitle: data.jobTitle || '',
      },
    }
  );
  return result.createPerson.id;
}

async function createApplicationNote(data, companyId) {
  const sections = [];

  sections.push(buildSection('Location Contact', [
    ['Contact Name', data.locationContactName],
    ['Job Title', data.locationJobTitle],
    ['Phone', data.locationPhone],
    ['Email', data.locationEmail],
    ['Location Address', data.locationAddress],
  ]));

  sections.push(buildSection('Declaration', [
    ['Print Name', data.printName],
    ['Signature', data.signature],
    ['Date', data.signatureDate],
  ]));

  const body = sections.filter(Boolean).join('\n\n');
  const title = `IrishPayments Application - ${data.tradingName || 'New Applicant'}`;

  await createNoteForCompany(companyId, title, body);
}

function buildSection(title, pairs) {
  const lines = pairs
    .filter(([, val]) => val)
    .map(([label, val]) => `- **${label}:** ${Array.isArray(val) ? val.join(', ') : val}`);
  return lines.length > 0 ? `## ${title}\n${lines.join('\n')}` : null;
}

async function createNoteForCompany(companyId, title, body) {
  const result = await graphql(
    `mutation CreateNote($input: NoteCreateInput!) {
      createNote(data: $input) { id }
    }`,
    { input: { title, bodyV2: { markdown: body } } }
  );
  const noteId = result.createNote.id;

  await graphql(
    `mutation CreateNoteTarget($input: NoteTargetCreateInput!) {
      createNoteTarget(data: $input) { id }
    }`,
    { input: { noteId, targetCompanyId: companyId } }
  );
}

const APP_DOCS_FIELD_ID = process.env.APP_DOCS_FIELD_ID || '386de559-5c01-4876-8c86-7a73c8fe7e78';

async function uploadFile(file, label) {
  const filename = `${label} - ${file.originalname}`;
  const fileSize = fs.statSync(file.path).size;

  const createResult = await graphql(
    `mutation CreateFileUpload($filename: String!, $size: Float!, $fileFolder: FileFolder!, $fieldMetadataId: String) {
      createFileUpload(filename: $filename, size: $size, fileFolder: $fileFolder, fieldMetadataId: $fieldMetadataId) {
        fileId uploadUrl contentType
      }
    }`,
    { filename, size: fileSize, fileFolder: 'FilesField', fieldMetadataId: APP_DOCS_FIELD_ID },
    'metadata'
  );

  const { fileId, uploadUrl, contentType } = createResult.createFileUpload;

  const fileStream = fs.readFileSync(file.path);
  const putResponse = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': contentType || 'application/octet-stream',
      'Authorization': `Bearer ${TWENTY_API_KEY}`,
    },
    body: fileStream,
  });

  if (!putResponse.ok) {
    console.error(`File PUT failed (${label}):`, await putResponse.text());
    return null;
  }

  await graphql(
    `mutation CompleteFileUpload($fileId: String!) {
      completeFileUpload(fileId: $fileId) { id }
    }`,
    { fileId },
    'metadata'
  );

  return { fileId, label: filename };
}

async function updateCompanyDocuments(companyId, fileRefs) {
  await graphql(
    `mutation UpdateCompany($id: ID!, $input: CompanyUpdateInput!) {
      updateCompany(id: $id, data: $input) { id }
    }`,
    { id: companyId, input: { applicationDocuments: fileRefs } }
  );
}

function cleanupAllFiles(filesMap) {
  if (!filesMap) return;
  for (const files of Object.values(filesMap)) {
    for (const file of files) {
      fs.unlink(file.path, () => {});
    }
  }
}

app.use(BASE_PATH, router);

if (BASE_PATH !== '/') {
  app.get('/', (_req, res) => res.redirect(BASE_PATH));
}

app.listen(PORT, () => {
  console.log(`Form service running on port ${PORT} at ${BASE_PATH}`);
});
