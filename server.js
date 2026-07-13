// server.js
// This is the entry point of our backend — the "shop assistant" that waits for requests.

require('dotenv').config(); // Loads variables from .env into process.env

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');

const app = express();

// ---- FILE UPLOAD SETUP ----

// Configure where and how uploaded files are saved
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/'); // saved into the /uploads folder
  },
  filename: function (req, file, cb) {
    // Generate a unique name so files never overwrite each other,
    // even if two customers upload files with the same original name
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

// Shopify credentials, loaded securely from .env (never hardcoded here)
const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ADMIN_API_TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;
const SHOPIFY_API_VERSION = '2024-10'; // Shopify updates this quarterly

// Allows our future calculator (on a different domain) to talk to this server
app.use(cors());

// Allows the server to understand JSON data sent to it (like calculator form data)
app.use(express.json());

// A simple test route — visiting this in a browser confirms the server is alive
app.get('/', (req, res) => {
  res.send('Quote backend is running.');
});

// ---- PRICING LOGIC (server-side, cannot be tampered with by the customer) ----

// Base price per square cm, depending on material
const MATERIAL_RATES = {
  Vinyl: 0.05,
  Paper: 0.03,
  Holographic: 0.08
};

// Finishing options add a percentage on top of the base price
const FINISHING_SURCHARGE = {
  Gloss: 0.10,   // +10%
  Matte: 0.05,   // +5%
  None: 0
};

function calculatePrice({ material, width, height, quantity, finish }) {
  const rate = MATERIAL_RATES[material];
  if (!rate) {
    throw new Error(`Unknown material: ${material}`);
  }

  const area = width * height; // cm²
  let pricePerUnit = area * rate;

  // Apply finishing surcharge
  const surcharge = FINISHING_SURCHARGE[finish] || 0;
  pricePerUnit = pricePerUnit + (pricePerUnit * surcharge);

  // Quantity discount tiers (more ordered = cheaper per unit)
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

// Builds ONE line item object from a single configured product.
// Kept separate so we can safely reuse it for multiple items in one order
// without any data leaking between them.
function buildLineItem(item, pricing) {
  return {
    title: `Custom Sticker - ${item.material} (${item.width}x${item.height}cm)`,
    price: pricing.pricePerUnit.toFixed(2), // server-calculated, never trusted from browser
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

// 'artwork' must match the field name the calculator uses when sending the file
app.post('/api/upload', upload.single('artwork'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: 'No file was uploaded.' });
  }

  // Build the full URL where this file can now be accessed
  const fileUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;

  console.log('File uploaded:', req.file.filename);

  res.json({
    message: 'File uploaded successfully.',
    fileUrl: fileUrl,
    originalName: req.file.originalname,
    size: req.file.size
  });
});

app.post('/api/quote', async (req, res) => {
  // The request body now looks like: { items: [ {...}, {...}, {...} ] }
  // Each object in the array is one custom product configuration.
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

    // Process each item completely independently —
    // this is what guarantees no data/pricing/files ever mix between items.
    for (const item of items) {
      // Every item gets its own unique ID, so its file/specs are traceable
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

// Start the server on port 3000 (you can change this if needed)
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});