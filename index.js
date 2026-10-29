/**
 * Rahbar Realms — WhatsApp Business Inquiry Agent
 * -------------------------------------------------
 * A Baileys-based INQUIRY-ONLY conversational agent.
 *
 * IMPORTANT LIMITATIONS (read before deploying):
 *  - Conversation state is kept IN MEMORY. It does NOT survive a process restart.
 *  - Confirmed inquiries are written to a local JSONL file if INQUIRY_LOG_PATH is set;
 *    otherwise they only live in memory and are lost on restart.
 *  - GitHub Actions is NOT a reliable 24/7 host. See setup instructions.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const P = require('pino');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  isJidGroup,
  isJidBroadcast,
} = require('@whiskeysockets/baileys');

// ============================================================================
// 1. BUSINESS CONFIGURATION  (edit this section only)
// ============================================================================

const BUSINESS = {
  name: 'Rahbar Realms',
  type: 'Digital Solutions & Web Development Agency',
  location: 'Online / Remote',
  // Public contact number shown to customers
  contactNumber: '03141619597',
  // WhatsApp bot number (must be the number actually paired with this session)
  botNumber: '03141619597',
  // Owner alert number: OPTIONAL. Leave empty string to disable notifications.
  // Format with country code, digits only, e.g. '923001234567'.
  ownerAlertNumber: process.env.OWNER_ALERT_NUMBER || '',
  automatedReplyHours: '24/7',
  humanSupportHours: 'To be confirmed',
  pricingPolicy: 'Custom quotation based on project requirements',
  delivery: 'No physical delivery — all services are digital.',
  paymentTerms: 'Discussed after the project quotation.',
};

// ============================================================================
// 2. SERVICES CONFIGURATION  (edit / add services here)
// ============================================================================

const SERVICES = [
  {
    id: 1,
    name: 'Website Development',
    description:
      'Designing and building responsive, modern websites tailored to a business\'s goals, including structure, layout, and core functionality.',
  },
  {
    id: 2,
    name: 'E-commerce Website Development',
    description:
      'Building online stores with product catalogs, cart and checkout flows, and the integrations needed to sell online.',
  },
  {
    id: 3,
    name: 'Custom Web Applications',
    description:
      'Developing tailored web applications with custom logic, dashboards, and workflows built around specific business requirements.',
  },
  {
    id: 4,
    name: 'Firebase & Database Integration',
    description:
      'Connecting apps and websites to databases and Firebase services such as authentication, real-time data, and storage.',
  },
  {
    id: 5,
    name: 'UI/UX Design',
    description:
      'Creating clean, user-friendly interface and experience designs focused on usability and brand consistency.',
  },
  {
    id: 6,
    name: 'Website Maintenance & Bug Fixing',
    description:
      'Ongoing upkeep, troubleshooting, and fixing of issues on existing websites to keep them stable and up to date.',
  },
  {
    id: 7,
    name: 'AI-Powered Business Solutions',
    description:
      'Integrating AI-driven features such as chatbots, automation, and smart assistants into business workflows.',
  },
];

// ============================================================================
// 3. RUNTIME CONFIG
// ============================================================================

const AUTH_DIR = process.env.AUTH_DIR || path.join(process.cwd(), 'auth_info');
const INQUIRY_LOG_PATH =
  process.env.INQUIRY_LOG_PATH || path.join(process.cwd(), 'inquiries.jsonl');
const LOG_LEVEL = process.env.LOG_LEVEL || 'warn';

const logger = P({ level: LOG_LEVEL });

// ============================================================================
// 4. VALIDATION
// ============================================================================

function digitsOnly(v) {
  return String(v || '').replace(/\D+/g, '');
}

function validateConfig() {
  const errors = [];
  if (!BUSINESS.name) errors.push('BUSINESS.name is empty');
  if (!digitsOnly(BUSINESS.contactNumber)) errors.push('BUSINESS.contactNumber invalid');
  if (!digitsOnly(BUSINESS.botNumber)) errors.push('BUSINESS.botNumber invalid');
  if (BUSINESS.ownerAlertNumber && digitsOnly(BUSINESS.ownerAlertNumber).length < 8) {
    errors.push('BUSINESS.ownerAlertNumber set but looks invalid');
  }
  if (!Array.isArray(SERVICES) || SERVICES.length === 0) errors.push('SERVICES is empty');
  SERVICES.forEach((s, i) => {
    if (!s.name || !s.description) errors.push(`SERVICES[${i}] missing name/description`);
  });
  if (errors.length) {
    throw new Error('Configuration errors:\n - ' + errors.join('\n - '));
  }
}

// ============================================================================
// 5. IN-MEMORY STATE (per sender)
// ============================================================================
// Map<normalizedSenderId, Session>
// Session = {
//   stage: 'idle' | 'awaiting_confirm' | 'collecting',
//   step: integer (0..7),
//   data: { name, service, description, features, timeline, budget, extra },
//   history: [ { step, key, previousValue } ],   // for BACK
//   lastActivity: ms,
//   processedMsgIds: Set<string>,
// }
// ----------------------------------------------------------------------------

const sessions = new Map();

const SESSION_TTL_MS = 1000 * 60 * 60; // 1 hour idle expiry
const MAX_PROCESSED_IDS = 100;

function getSession(senderId) {
  const now = Date.now();
  let s = sessions.get(senderId);
  if (!s) {
    s = newSession();
    sessions.set(senderId, s);
  } else if (now - s.lastActivity > SESSION_TTL_MS) {
    s = newSession();
    sessions.set(senderId, s);
  }
  s.lastActivity = now;
  return s;
}

function newSession() {
  return {
    stage: 'idle',
    step: 0,
    data: { name: '', service: '', description: '', features: '', timeline: '', budget: '', extra: '' },
    history: [],
    lastActivity: Date.now(),
    processedMsgIds: new Set(),
  };
}

function resetInquiry(session) {
  session.stage = 'idle';
  session.step = 0;
  session.data = { name: '', service: '', description: '', features: '', timeline: '', budget: '', extra: '' };
  session.history = [];
}

// ============================================================================
// 6. TEXT NORMALIZATION HELPERS
// ============================================================================

function normalizeText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\u2018\u2019\u201C\u201D]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isGreeting(text) {
  const t = normalizeText(text);
  if (!t) return false;
  return [
    'hi', 'hii', 'hiii', 'hey', 'heyy', 'hello', 'helo', 'hlo',
    'salam', 'assalam o alaikum', 'assalamualaikum', 'asalam o alaikum',
    'asalamualaikum', 'aoa', 'salam alaikum', 'wa alaikum salam',
  ].includes(t) || /^(hi|hello|hey|hlo|salam)\b/.test(t);
}

function isCancel(text) {
  const t = normalizeText(text);
  return ['cancel', 'cancel inquiry', 'stop', 'exit', 'quit'].includes(t);
}

function isBack(text) {
  const t = normalizeText(text);
  return ['back', 'previous', 'go back'].includes(t);
}

function isConfirm(text) {
  const t = normalizeText(text);
  return ['yes', 'y', 'confirm', 'ok', 'okay', 'sure', 'correct', 'proceed', 'submit', '1'].includes(t);
}

function isDeny(text) {
  const t = normalizeText(text);
  return ['no', 'n', 'nope', 'cancel', 'stop', '2'].includes(t);
}

function matchServiceByInput(text) {
  const t = normalizeText(text);
  if (!t) return null;
  // direct number match
  if (/^\d+$/.test(t)) {
    const n = parseInt(t, 10);
    return SERVICES.find((s) => s.id === n) || null;
  }
  // name match (loose)
  let best = null;
  for (const s of SERVICES) {
    const sName = normalizeText(s.name);
    if (sName.includes(t) || t.includes(sName)) {
      if (!best || sName.length > normalizeText(best.name).length) best = s;
    }
  }
  if (best) return best;
  // keyword heuristics
  const keywords = {
    1: ['website', 'site', 'web development'],
    2: ['ecommerce', 'e commerce', 'store', 'shop', 'online store'],
    3: ['custom app', 'web app', 'application', 'custom web'],
    4: ['firebase', 'database', 'db'],
    5: ['ui', 'ux', 'design', 'interface'],
    6: ['maintenance', 'bug', 'fix', 'support'],
    7: ['ai', 'artificial intelligence', 'chatbot', 'automation'],
  };
  for (const [id, kws] of Object.entries(keywords)) {
    if (kws.some((k) => t.includes(k))) {
      return SERVICES.find((s) => s.id === parseInt(id, 10)) || null;
    }
  }
  return null;
}

// ============================================================================
// 7. MESSAGE BUILDERS
// ============================================================================

function welcomeMessage() {
  return (
    `Assalam o Alaikum! 👋\n\n` +
    `Welcome to *${BUSINESS.name}* — ${BUSINESS.type}.\n` +
    `We work ${BUSINESS.location.toLowerCase()}.\n\n` +
    `Please choose an option:\n\n` +
    `1 — View Services\n` +
    `2 — Get Service Details\n` +
    `3 — Start a Project Inquiry\n` +
    `4 — Pricing Information\n` +
    `5 — Contact Information\n\n` +
    `Reply with a number or keyword (e.g. *services*, *pricing*).`
  );
}

function servicesMessage() {
  const lines = SERVICES.map((s) => `${s.id}. *${s.name}*`).join('\n');
  return (
    `*Our Services at ${BUSINESS.name}*\n\n` +
    `${lines}\n\n` +
    `Reply with a service *number* or *name* for details, or send *PROJECT INQUIRY* to start.\n` +
    `Send *MENU* to see the main options again.`
  );
}

function serviceDetailsMessage(service) {
  return (
    `*${service.name}*\n\n` +
    `${service.description}\n\n` +
    `Would you like to start a project inquiry for this service?\n` +
    `Reply *PROJECT INQUIRY* to begin, or send *MENU* to return to the main options.`
  );
}

function pricingMessage() {
  return (
    `*Pricing Information*\n\n` +
    `Our pricing depends on your project's requirements, features, and complexity. ` +
    `${BUSINESS.name} provides ${BUSINESS.pricingPolicy.toLowerCase()} after understanding your project.\n\n` +
    `Payment terms: ${BUSINESS.paymentTerms}\n\n` +
    `Would you like to start a project inquiry? Reply *PROJECT INQUIRY* to begin.`
  );
}

function contactMessage() {
  return (
    `*Contact Information*\n\n` +
    `Business: ${BUSINESS.name}\n` +
    `Phone / WhatsApp: ${BUSINESS.contactNumber}\n` +
    `Location: ${BUSINESS.location}\n` +
    `Automated replies: ${BUSINESS.automatedReplyHours}\n` +
    `Human support hours: ${BUSINESS.humanSupportHours}\n\n` +
    `Delivery: ${BUSINESS.delivery}\n\n` +
    `To get started, reply *PROJECT INQUIRY* or send *MENU* for options.`
  );
}

function unknownMessage() {
  return (
    `Sorry, I didn't quite understand that.\n\n` +
    `Please reply with:\n` +
    `1 — View Services\n` +
    `2 — Get Service Details\n` +
    `3 — Start a Project Inquiry\n` +
    `4 — Pricing Information\n` +
    `5 — Contact Information\n\n` +
    `Or send *MENU* at any time.`
  );
}

function inquiryStepPrompt(session) {
  const step = session.step;
  switch (step) {
    case 1:
      return 'Great! Let\'s start your project inquiry.\n\nStep 1 of 7 — What is your *full name*?';
    case 2:
      return `Step 2 of 7 — Which *service* are you interested in?\n\n` +
        SERVICES.map((s) => `${s.id}. ${s.name}`).join('\n') +
        `\n\nReply with a number or name.`;
    case 3:
      return 'Step 3 of 7 — Please give a *brief description* of your project.';
    case 4:
      return 'Step 4 of 7 — What are the *required features or main goals*? (type *skip* to skip)';
    case 5:
      return 'Step 5 of 7 — What is your *preferred timeline*? (e.g. 2 weeks, 1 month, flexible). Type *skip* to skip.';
    case 6:
      return 'Step 6 of 7 — What is your *budget range*? (optional — type *skip* if you prefer not to share)';
    case 7:
      return 'Step 7 of 7 — Any *additional requirements*? Type *skip* if none.';
    default:
      return null;
  }
}

function inquirySummaryMessage(data) {
  return (
    `*Please review your inquiry:*\n\n` +
    `👤 Name: ${data.name || '—'}\n` +
    `🛠️ Service: ${data.service || '—'}\n` +
    `📝 Description: ${data.description || '—'}\n` +
    `⚙️ Features / Goals: ${data.features || '—'}\n` +
    `📅 Timeline: ${data.timeline || '—'}\n` +
    `💰 Budget: ${data.budget || '—'}\n` +
    `➕ Additional: ${data.extra || '—'}\n\n` +
    `Reply *CONFIRM* to submit, or *CANCEL* to cancel.`
  );
}

// ============================================================================
// 8. INQUIRY STORAGE
// ============================================================================

let inquiryCounter = 0;

function generateReference() {
  inquiryCounter += 1;
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 12);
  return `RR-${stamp}-${String(inquiryCounter).padStart(3, '0')}`;
}

function persistInquiry(record) {
  // Always log locally; optionally append to file
  try {
    if (INQUIRY_LOG_PATH) {
      fs.mkdirSync(path.dirname(INQUIRY_LOG_PATH), { recursive: true });
      fs.appendFileSync(INQUIRY_LOG_PATH, JSON.stringify(record) + '\n', 'utf8');
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'Failed to persist inquiry to disk');
  }
}

// ============================================================================
// 9. SESSION HANDLERS
// ============================================================================

function handleIdle(session, text) {
  const t = normalizeText(text);

  if (isGreeting(text) || t === 'menu' || t === 'start') {
    return welcomeMessage();
  }

  if (['1', 'services', 'service', 'menu services', 'view services'].includes(t)) {
    return servicesMessage();
  }

  if (['2', 'details', 'service details', 'get service details'].includes(t)) {
    return (
      'Please reply with the *number* or *name* of the service you\'d like to know more about:\n\n' +
      SERVICES.map((s) => `${s.id}. ${s.name}`).join('\n')
    );
  }

  if (['3', 'project', 'project inquiry', 'start project', 'start a project inquiry', 'inquiry'].includes(t)) {
    session.stage = 'collecting';
    session.step = 1;
    session.data = { name: '', service: '', description: '', features: '', timeline: '', budget: '', extra: '' };
    session.history = [];
    return inquiryStepPrompt(session);
  }

  if (['4', 'pricing', 'price', 'prices', 'cost', 'rates'].includes(t)) {
    return pricingMessage();
  }

  if (['5', 'contact', 'contact info', 'contact information', 'phone'].includes(t)) {
    return contactMessage();
  }

  // Service-by-name / number (idle)
  const svc = matchServiceByInput(text);
  if (svc) {
    return serviceDetailsMessage(svc);
  }

  return unknownMessage();
}

function handleCollecting(session, text) {
  if (isCancel(text)) {
    resetInquiry(session);
    return 'Inquiry cancelled. Send *MENU* to see options again.';
  }

  if (isBack(text)) {
    const last = session.history.pop();
    if (!last) {
      return 'Nothing to go back to. Continuing with the current step.\n\n' + inquiryStepPrompt(session);
    }
    session.step = last.step;
    session.data[last.key] = last.previousValue;
    return inquiryStepPrompt(session);
  }

  const step = session.step;
  const raw = String(text || '').trim();
  const skip = normalizeText(raw) === 'skip';

  if (!raw) {
    return inquiryStepPrompt(session);
  }

  switch (step) {
    case 1: {
      if (raw.length < 2) return 'Please provide your name (at least 2 characters).';
      session.history.push({ step, key: 'name', previousValue: session.data.name });
      session.data.name = raw.slice(0, 100);
      break;
    }
    case 2: {
      const svc = matchServiceByInput(raw);
      if (!svc) {
        return 'Please reply with a valid service *number* or *name* from the list:\n\n' +
          SERVICES.map((s) => `${s.id}. ${s.name}`).join('\n');
      }
      session.history.push({ step, key: 'service', previousValue: session.data.service });
      session.data.service = svc.name;
      break;
    }
    case 3: {
      if (raw.length < 3) return 'Please give a short description (at least 3 characters).';
      session.history.push({ step, key: 'description', previousValue: session.data.description });
      session.data.description = raw.slice(0, 500);
      break;
    }
    case 4: {
      session.history.push({ step, key: 'features', previousValue: session.data.features });
      session.data.features = skip ? '—' : raw.slice(0, 500);
      break;
    }
    case 5: {
      session.history.push({ step, key: 'timeline', previousValue: session.data.timeline });
      session.data.timeline = skip ? '—' : raw.slice(0, 100);
      break;
    }
    case 6: {
      session.history.push({ step, key: 'budget', previousValue: session.data.budget });
      session.data.budget = skip ? '—' : raw.slice(0, 100);
      break;
    }
    case 7: {
      session.history.push({ step, key: 'extra', previousValue: session.data.extra });
      session.data.extra = skip ? '—' : raw.slice(0, 500);
      // done -> go to confirmation
      session.stage = 'awaiting_confirm';
      session.step = 0;
      return inquirySummaryMessage(session.data);
    }
    default:
      return unknownMessage();
  }

  session.step = step + 1;
  return inquiryStepPrompt(session);
}

function handleAwaitingConfirm(session, text) {
  if (isConfirm(text)) {
    const ref = generateReference();
    const record = {
      ref,
      createdAt: new Date().toISOString(),
      customerId: session.senderId || null,
      customerName: session.data.name,
      service: session.data.service,
      description: session.data.description,
      features: session.data.features,
      timeline: session.data.timeline,
      budget: session.data.budget,
      extra: session.data.extra,
    };
    return { action: 'submit', record };
  }
  if (isDeny(text) || isCancel(text)) {
    resetInquiry(session);
    return { action: 'cancelled' };
  }
  // Allow editing by starting over
  return { action: 'prompt' };
}

// ============================================================================
// 10. MESSAGE PROCESSOR
// ============================================================================

async function handleIncoming(sock, msg) {
  try {
    if (!msg.message) return;
    if (msg.key?.fromMe) return;
    const remoteJid = msg.key?.remoteJid;
    if (!remoteJid) return;
    if (isJidGroup(remoteJid)) return; // ignore groups
    if (isJidBroadcast(remoteJid)) return;
    if (remoteJid === 'status@broadcast') return;

    const senderId = jidNormalizedUser(remoteJid);
    const msgId = msg.key?.id;
    if (!msgId) return;

    // Extract text
    const m = msg.message;
    const text =
      m.conversation ||
      m.extendedTextMessage?.text ||
      m.imageMessage?.caption ||
      m.videoMessage?.caption ||
      m.buttonsResponseMessage?.selectedButtonId ||
      m.listResponseMessage?.singleSelectReply?.selectedRowId ||
      m.templateButtonReplyMessage?.selectedId ||
      '';

    const session = getSession(senderId);
    session.senderId = senderId;

    // Deduplicate
    if (session.processedMsgIds.has(msgId)) return;
    session.processedMsgIds.add(msgId);
    if (session.processedMsgIds.size > MAX_PROCESSED_IDS) {
      const first = session.processedMsgIds.values().next().value;
      session.processedMsgIds.delete(first);
    }

    let reply = null;

    if (session.stage === 'collecting') {
      reply = handleCollecting(session, text);
    } else if (session.stage === 'awaiting_confirm') {
      const r = handleAwaitingConfirm(session, text);
      if (r.action === 'submit') {
        persistInquiry(r.record);
        reply =
          `✅ Thank you, ${r.record.customerName}!\n\n` +
          `Your inquiry *${r.record.ref}* has been recorded by our automated system.\n\n` +
          `We will review the details and follow up regarding next steps. ` +
          `You can send *MENU* at any time to explore our services.\n\n` +
          `_Note: this is an automated acknowledgement. A team member has not personally reviewed your inquiry yet._`;

        // Owner notification (best-effort, non-fatal)
        if (BUSINESS.ownerAlertNumber) {
          const ownerNum = digitsOnly(BUSINESS.ownerAlertNumber);
          if (ownerNum.length >= 8) {
            const ownerJid = `${ownerNum}@s.whatsapp.net`;
            const body =
              `🔔 *New Inquiry — ${BUSINESS.name}*\n\n` +
              `Ref: ${r.record.ref}\n` +
              `Customer: ${r.record.customerName}\n` +
              `WhatsApp: ${senderId}\n` +
              `Service: ${r.record.service}\n` +
              `Description: ${r.record.description}\n` +
              `Features: ${r.record.features}\n` +
              `Timeline: ${r.record.timeline}\n` +
              `Budget: ${r.record.budget}\n` +
              `Additional: ${r.record.extra}\n` +
              `Submitted: ${r.record.createdAt}`;
            // fire and forget, do not crash if it fails
            sock.sendMessage(ownerJid, { text: body }).catch((err) => {
              logger.warn({ err: err.message }, 'Owner notification failed');
            });
          } else {
            logger.warn('OWNER_ALERT_NUMBER is set but invalid; skipping notification');
          }
        }

        resetInquiry(session);
        session.stage = 'idle';
      } else if (r.action === 'cancelled') {
        reply = 'Inquiry cancelled. Send *MENU* to see options again.';
      } else {
        reply =
          'Please reply with *CONFIRM* to submit, or *CANCEL* to cancel your inquiry.';
      }
    } else {
      reply = handleIdle(session, text);
    }

    if (reply) {
      await sock.sendMessage(remoteJid, { text: reply });
    }
  } catch (err) {
    logger.error({ err: err.message }, 'handleIncoming error');
  }
}

// ============================================================================
// 11. SOCKET LIFECYCLE
// ============================================================================

let sockRef = null;
let reconnectTimer = null;
let shuttingDown = false;

async function startSock() {
  if (shuttingDown) return;

  // Avoid duplicate sockets
  if (sockRef) {
    try { sockRef.end(undefined); } catch (_) {}
    sockRef = null;
  }

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  let version = [2, 3000, 0];
  try {
    const v = await fetchLatestBaileysVersion();
    if (v?.version) version = v.version;
  } catch (err) {
    logger.warn({ err: err.message }, 'Using fallback Baileys version');
  }

  const sock = makeWASocket({
    version,
    auth: state,
    logger: P({ level: 'silent' }),
    printQRInTerminal: true, // printed only if pairing is not used
    browser: ['Rahbar Realms Bot', 'Chrome', '1.0.0'],
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
  });

  sockRef = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'open') {
      logger.info('WhatsApp connection opened');
    } else if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const reason = lastDisconnect?.error?.message || 'unknown';
      logger.warn({ code, reason }, 'Connection closed');

      const shouldReconnect =
        code !== DisconnectReason.loggedOut && !shuttingDown;

      if (shouldReconnect) {
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
          logger.info('Attempting reconnect...');
          startSock().catch((e) =>
            logger.error({ err: e.message }, 'Reconnect failed'),
          );
        }, 5000);
      } else {
        logger.error('Logged out — re-pair required.');
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      await handleIncoming(sock, msg);
    }
  });
}

// ============================================================================
// 12. PAIRING MODE (optional)
// ============================================================================
// To pair without printing a QR in a headless workflow, set PAIRING_NUMBER
// to the bot number (digits with country code, e.g. 923141619597).
// The bot will print a pairing code you enter in WhatsApp > Linked Devices.
// ----------------------------------------------------------------------------

async function requestPairingIfNeeded(sock, state) {
  const pairing = digitsOnly(process.env.PAIRING_NUMBER || '');
  if (!pairing) return;
  if (state.creds?.registered) return;
  try {
    const code = await sock.requestPairingCode(pairing);
    logger.warn(
      { pairingCode: code, note: 'Enter this in WhatsApp > Linked Devices > Link with phone number' },
      'PAIRING CODE (valid ~60s)',
    );
    // Also print plainly so it appears in the Actions log clearly
    console.log(`\n=== WHATSAPP PAIRING CODE: ${code} ===\n`);
  } catch (err) {
    logger.warn({ err: err.message }, 'Pairing code request failed');
  }
}

// ============================================================================
// 13. ENTRY POINT
// ============================================================================

async function main() {
  validateConfig();

  // We must create the socket first to be able to request pairing,
  // so we wrap startSock in a variant that exposes the pairing hook.
  if (process.env.PAIRING_NUMBER) {
    const { state } = await useMultiFileAuthState(AUTH_DIR);
    if (!state.creds?.registered) {
      logger.warn('Not registered — requesting pairing code before main loop');
      // Start a temporary socket to request pairing, then let normal loop take over
      const tempSock = makeWASocket({
        auth: state,
        logger: P({ level: 'silent' }),
        printQRInTerminal: false,
        browser: ['Rahbar Realms Bot', 'Chrome', '1.0.0'],
      });
      await requestPairingIfNeeded(tempSock, state);
      try { tempSock.end(undefined); } catch (_) {}
      // Give the user a moment — the creds are saved by tempSock, and the
      // next socket will pick them up. In unattended runs the pairing will
      // NOT succeed because a human must enter the code.
      logger.warn(
        'Awaiting pair confirmation. If running unattended in CI, this WILL fail — pair locally first and commit auth_info (or use a secret).',
      );
    }
  }

  await startSock();

  process.on('SIGINT', () => {
    shuttingDown = true;
    try { sockRef?.end(undefined); } catch (_) {}
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    shuttingDown = true;
    try { sockRef?.end(undefined); } catch (_) {}
    process.exit(0);
  });
  process.on('uncaughtException', (e) => logger.error({ err: e.message }, 'uncaughtException'));
  process.on('unhandledRejection', (e) => logger.error({ err: String(e) }, 'unhandledRejection'));
}

main().catch((err) => {
  logger.error({ err: err.message }, 'Fatal startup error');
  process.exit(1);
});
