require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(bodyParser.json());

const SHOPIFY_API_VERSION = '2024-04';
const SHOPIFY_STORE = snuslyf.myshopify.com;
const SHOPIFY_ADMIN_API = `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}`;
const ADMIN_TOKEN = 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;

const shopifyRequest = async (query, variables = {}) => {
  const res = await axios.post(`${SHOPIFY_ADMIN_API}/graphql.json`, {
    query,
    variables
  }, {
    headers: {
      'X-Shopify-Access-Token': ADMIN_TOKEN,
      'Content-Type': 'application/json'
    }
  });
  return res.data;
};

const getOrderDetails = async (orderId) => {
  const query = `
    query GetOrder($id: ID!) {
      order(id: $id) {
        lineItems(first: 50) {
          edges {
            node {
              name
              quantity
              properties {
                name
                value
              }
              variant {
                id
                inventoryItem {
                  id
                }
              }
            }
          }
        }
        fulfillments(first: 1) {
          edges {
            node {
              location {
                id
              }
            }
          }
        }
      }
    }
  `;
  const variables = { id: orderId };
  const response = await shopifyRequest(query, variables);
  return response.data?.order;
};

const adjustInventory = async (changes) => {
  const mutation = `
    mutation AdjustInventory($input: InventoryAdjustQuantitiesInput!) {
      inventoryAdjustQuantities(input: $input) {
        inventoryAdjustmentGroup {
          createdAt
          reason
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const input = {
    reason: "correction",
    referenceDocumentUri: "https://yourdomain.com/ledger",
    changes: changes
  };

  const response = await shopifyRequest(mutation, { input });
  return response;
};

app.post('/bundle-adjust', async (req, res) => {
  try {
    const rawOrderId = req.body.order_id;
    const orderId = rawOrderId.startsWith('gid://') ? rawOrderId : `gid://shopify/Order/${rawOrderId}`;
    console.log(`[Server] Received order ID: ${orderId}`);

    const order = await getOrderDetails(orderId);
    if (!order) throw new Error("Order not found.");

    const lineItems = order.lineItems.edges.map(edge => edge.node);

    const bundleItems = lineItems
      .map(item => {
        const bundleProp = item.properties.find(p => p.name === '_BundleComponents');
        return bundleProp ? { quantity: item.quantity, components: bundleProp.value } : null;
      })
      .filter(Boolean);

    if (bundleItems.length === 0) {
      console.log("[Bundle] No bundle components found.");
      return res.status(200).send("No bundles to adjust.");
    }

    const locationId = order.fulfillments?.edges?.[0]?.node?.location?.id;
    if (!locationId) throw new Error("Location ID not found.");
    console.log(`[Location] Using location ID: ${locationId}`);

    const changes = [];

    for (const bundle of bundleItems) {
      console.log(`[Bundle] Found _BundleComponents: ${bundle.components}`);

      const components = bundle.components.split(',').map(comp => {
        const [itemId, qty] = comp.trim().split('|').map(s => s.trim());
        return { itemId, qty: parseInt(qty) };
      });

      for (const comp of components) {
        const inventoryItemId = `gid://shopify/InventoryItem/${comp.itemId}`;
        changes.push({
          inventoryItemId,
          delta: -comp.qty * bundle.quantity,
          locationId
        });
      }
    }

    const response = await adjustInventory(changes);
    console.log('[DEBUG] GraphQL raw response:', JSON.stringify(response, null, 2));

    const userErrors = response.data?.inventoryAdjustQuantities?.userErrors || [];
    if (userErrors.length > 0) {
      console.error('[GraphQL user errors]', userErrors);
      return res.status(500).json({ errors: userErrors });
    }

    return res.status(200).send('Inventory adjusted successfully.');
  } catch (err) {
    console.error('[❌ ERROR]', err.message || err);
    return res.status(500).send('Server error');
  }
});

app.listen(PORT, () => {
  console.log(`[Server] Listening on port ${PORT}`);
});
