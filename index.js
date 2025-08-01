const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 10000;

// 🔧 Your credentials:
const SHOPIFY_ACCESS_TOKEN = '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';
const SHOPIFY_STORE_URL = 'snuslyf.myshopify.com';

// =============================
// 📡 Shopify GraphQL Request
// =============================
const shopifyRequest = async (query, variables = {}) => {
  const url = `https://${SHOPIFY_STORE_URL}/admin/api/2024-07/graphql.json`;

  try {
    const response = await axios.post(
      url,
      { query, variables },
      {
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
          'Content-Type': 'application/json',
        },
      }
    );

    if (response.data.errors) {
      console.error('[GraphQL top-level errors]', response.data.errors);
    }
    if (response.data.data?.inventoryAdjustQuantities?.userErrors?.length) {
      console.error('[GraphQL user errors]', response.data.data.inventoryAdjustQuantities.userErrors);
    }

    return response.data;
  } catch (error) {
    console.error('[❌ ERROR]', error.message);
    throw error;
  }
};

// =============================
// 🔍 Get Order Info
// =============================
const getOrderDetails = async (orderId) => {
  const query = `
    query GetOrder($id: ID!) {
      order(id: $id) {
        lineItems(first: 50) {
          nodes {
            name
            quantity
            customAttributes {
              key
              value
            }
          }
        }
        fulfillments {
          location {
            id
          }
        }
      }
    }
  `;

  const base64OrderId = Buffer.from(orderId).toString('base64');
  const response = await shopifyRequest(query, { id: base64OrderId });
  return response.data?.order;
};

// =============================
// 📉 Adjust Inventory
// =============================
const adjustInventory = async (locationId, adjustments) => {
  const mutation = `
    mutation AdjustInventory($input: InventoryAdjustQuantitiesInput!) {
      inventoryAdjustQuantities(input: $input) {
        inventoryAdjustmentGroup {
          createdAt
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const input = {
    name: "available",
    reason: "correction",
    changes: adjustments.map(adj => ({
      inventoryItemId: `gid://shopify/InventoryItem/${adj.inventoryItemId}`,
      delta: -adj.quantity,
      locationId,
      ledgerDocumentUri: "https://yourdomain.com/ledger"
    }))
  };

  return await shopifyRequest(mutation, { input });
};

// =============================
// 📦 Bundle Adjust Endpoint
// =============================
app.use(bodyParser.json());

app.post('/bundle-adjust', async (req, res) => {
  try {
    const rawOrderId = req.body.order_id;
    console.log('[Server] Received order ID:', rawOrderId);

    const orderId = rawOrderId.startsWith('gid://') ? rawOrderId : `gid://shopify/Order/${rawOrderId}`;
    const order = await getOrderDetails(orderId);

    if (!order) {
      console.error('[❌ ERROR] Order not found.');
      return res.status(404).send('Order not found');
    }

    const locationId = order.fulfillments?.[0]?.location?.id;
    if (!locationId) {
      console.error('[❌ ERROR] Location ID not found.');
      return res.status(400).send('Location not found');
    }

    console.log('[Location] Using location ID:', locationId);

    const adjustments = [];

    for (const item of order.lineItems.nodes) {
      const { quantity, customAttributes } = item;

      const bundleProp = customAttributes?.find(p => p.key === '_BundleComponents');
      if (!bundleProp || !bundleProp.value) continue;

      const components = bundleProp.value.split(',').map(x => x.trim());
      for (const component of components) {
        const [itemId, qty] = component.split('|').map(x => x.trim());
        adjustments.push({
          inventoryItemId: itemId,
          quantity: parseInt(qty) * quantity
        });
      }

      console.log('[Bundle] Found _BundleComponents:', bundleProp.value);
    }

    if (adjustments.length === 0) {
      console.log('[Server] No bundle components to adjust.');
      return res.status(200).send('No bundles found.');
    }

    const response = await adjustInventory(locationId, adjustments);
    return res.status(200).send('Inventory adjusted.');
  } catch (err) {
    console.error('[❌ ERROR]', err);
    res.status(500).send('Error adjusting inventory');
  }
});

app.listen(PORT, () => {
  console.log(`[✅ Server] Running on port ${PORT}`);
});
