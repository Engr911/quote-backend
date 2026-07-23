// server.js
// This is the entry point of our backend — the "shop assistant" that waits for requests.

require('dotenv').config(); // Loads variables from .env into process.env

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const app = express();

// Shopify credentials, loaded securely from .env (never hardcoded here)
const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ADMIN_API_TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;
const SHOPIFY_API_VERSION = '2024-10'; // Shopify updates this quarterly

// Automatically create the uploads folder if it doesn't exist yet.
// This means we never depend on manually creating an empty folder
// before deploying — the server creates it itself on startup.
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
  console.log('Created uploads directory.');
}

// Allows our future calculator (on a different domain) to talk to this server
app.use(cors());

// Allows the server to understand JSON data sent to it (like calculator form data)
app.use(express.json());

// ---- FILE UPLOAD SETUP ----

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/');
  },
  filename: function (req, file, cb) {
    const uniqueId = crypto.randomUUID();
    const extension = path.extname(file.originalname);
    cb(null, `${uniqueId}${extension}`);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 20 * 1024 * 1024 } // 20MB max file size
});

// Let the browser access uploaded files via a URL (e.g. /uploads/filename.png)
app.use('/uploads', express.static('uploads'));

// A simple test route — visiting this in a browser confirms the server is alive
app.get('/', (req, res) => {
  res.send('Quote backend is running.');
});

// ---- PRICING LOGIC (server-side, cannot be tampered with by the customer) ----

const MATERIAL_RATES = {
  Vinyl: 0.05,
  Paper: 0.03,
  Holographic: 0.08
};

const FINISHING_SURCHARGE = {
  Gloss: 0.10,
  Matte: 0.05,
  None: 0
};

function calculatePrice({ material, width, height, quantity, finish }) {
  const rate = MATERIAL_RATES[material];
  if (!rate) {
    throw new Error(`Unknown material: ${material}`);
  }

  const area = width * height; // cm²
  let pricePerUnit = area * rate;

  const surcharge = FINISHING_SURCHARGE[finish] || 0;
  pricePerUnit = pricePerUnit + (pricePerUnit * surcharge);

  let discount = 0;
  if (quantity >= 500) discount = 0.20;
  else if (quantity >= 200) discount = 0.10;
  else if (quantity >= 50) discount = 0.05;

  pricePerUnit = pricePerUnit - (pricePerUnit * discount);

  const totalPrice = pricePerUnit * quantity;

  return {
    pricePerUnit: Math.round(pricePerUnit * 100) / 100,
    totalPrice: Math.round(totalPrice * 100) / 100,
    discountApplied: discount,
    surchargeApplied: surcharge
  };
}

// ---- SHOPIFY INTEGRATION ----

function buildLineItem(item, pricing) {
  return {
    title: `Custom Sticker - ${item.material} (${item.width}x${item.height}cm)`,
    price: pricing.pricePerUnit.toFixed(2),
    quantity: item.quantity,
    properties: [
      { name: 'Material', value: item.material },
      { name: 'Finish', value: item.finish || 'None' },
      { name: 'Width (cm)', value: String(item.width) },
      { name: 'Height (cm)', value: String(item.height) },
      { name: 'Quote ID', value: item.quoteId },
      { name: 'Artwork File', value: item.fileUrl || 'No file uploaded' }
    ]
  };
}

async function createShopifyDraftOrder(lineItems, noteLines) {
  const url = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/draft_orders.json`;

  const draftOrderPayload = {
    draft_order: {
      line_items: lineItems,
      note: noteLines.join('\n')
    }
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': SHOPIFY_ADMIN_API_TOKEN
    },
    body: JSON.stringify(draftOrderPayload)
  });

  const result = await response.json();

  if (!response.ok) {
    throw new Error(
      'Shopify API error: ' + JSON.stringify(result.errors || result)
    );
  }

  return result.draft_order;
}

// ---- FILE UPLOAD ENDPOINT ----

app.post('/api/upload', upload.single('artwork'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: 'No file was uploaded.' });
  }

  const fileUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;

  console.log('File uploaded:', req.file.filename);

  res.json({
    message: 'File uploaded successfully.',
    fileUrl: fileUrl,
    originalName: req.file.originalname,
    size: req.file.size
  });
});

// ---- THE QUOTE ENDPOINT ----

app.post('/api/quote', async (req, res) => {
  const items = req.body.items;

  console.log('Received order data:', items);

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({
      message: 'Request must include a non-empty "items" array.'
    });
  }

  try {
    const lineItems = [];
    const noteLines = ['Custom quote order — multiple items:'];
    const pricedItems = [];

    for (const item of items) {
      const quoteId = crypto.randomUUID();
      const itemWithId = { ...item, quoteId };

      const pricing = calculatePrice(itemWithId);
      const lineItem = buildLineItem(itemWithId, pricing);

      lineItems.push(lineItem);
      noteLines.push(
        `- ${item.material}, ${item.finish || 'None'} finish, ${item.width}x${item.height}cm, qty ${item.quantity}, Quote ID: ${quoteId}`
      );
      pricedItems.push({ ...itemWithId, pricing });
    }

    const draftOrder = await createShopifyDraftOrder(lineItems, noteLines);

    res.json({
      message: 'Quote calculated and draft order created successfully.',
      items: pricedItems,
      draftOrder: {
        id: draftOrder.id,
        name: draftOrder.name,
        invoice_url: draftOrder.invoice_url,
        total_price: draftOrder.total_price
      }
    });
  } catch (err) {
    console.error('Error:', err.message);
    res.status(400).json({
      message: 'Could not process quote.',
      error: err.message
    });
  }
});

// Catches any error we didn't handle explicitly above,
// and always responds with JSON (never an HTML crash page)
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    message: 'Something went wrong on the server.',
    error: err.message
  });
});

// Start the server. Render assigns its own PORT via environment variable —
// process.env.PORT is used when available, falling back to 3000 locally.
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});