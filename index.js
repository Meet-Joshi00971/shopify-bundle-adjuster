const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");

const app = express();
const port = 3000;

// 🔐 Hardcoded credentials
const SHOP = "snuslyf.myshopify.com";
const ACCESS_TOKEN = "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";
const LOCATION_ID = "gid://shopify/Location/108654461258";

app.use(bodyParser.json());

app.post("/bundle-adjust", async (req, res) => {
  try {
    const orderGID = req.body.order_id;
    console.log("[Server] Received order ID:", orderGID);

    // 🔎 Fetch order
    const order = await getOrder(orderGID);
    if (!order) {
      console.error("[❌ ERROR] Order not found.");
      return res.status(404).send("Order not found");
    }

    const adjustments = [];

    for (const item of order.lineItems.nodes) {
      const { quantity, customAttributes } = item;
      const bundleProp = customAttributes?.find(p => p.key === "_BundleComponents");

      if (!bundleProp || !bundleProp.value) continue;

      const components = bundleProp.value.split(",").map(x => x.trim());

      for (const component of components) {
        const [variantId, qty] = component.split("|").map(x => x.trim());
        const inventoryItemGID = await getInventoryItemId(variantId);
        if (!inventoryItemGID) {
          console.warn(`[⚠️ Warning] Inventory item ID not found for variant ${variantId}`);
          continue;
        }

        adjustments.push({
          inventoryItemId: inventoryItemGID,
          quantity: parseInt(qty) * quantity
        });
      }

      console.log("[Bundle] Found _BundleComponents:", bundleProp.value);
    }

    if (adjustments.length === 0) {
      console.log("[✅] No inventory adjustments needed.");
      return res.status(200).send("No adjustments");
    }

    const input = {
      name: "available",
      reason: "correction",
      changes: adjustments.map(adj => ({
        inventoryItemId: adj.inventoryItemId,
        delta: -adj.quantity,
        locationId: LOCATION_ID
      }))
    };

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

    const response = await shopifyRequest(mutation, { input });

    const errors = response?.data?.inventoryAdjustQuantities?.userErrors || [];

    if (errors.length > 0) {
      console.error("[GraphQL user errors]", errors);
      return res.status(500).send("Inventory adjustment failed");
    }

    console.log("[✅ Success] Inventory adjusted.");
    res.status(200).send("Inventory adjusted");
  } catch (err) {
    console.error("[❌ ERROR]", err.message || err);
    res.status(500).send("Server error");
  }
});

app.listen(port, () => {
  console.log(`[🟢 Server running on http://localhost:${port}]`);
});

async function getOrder(orderGID) {
  const query = `
    query GetOrder($id: ID!) {
      order(id: $id) {
        id
        lineItems(first: 50) {
          nodes {
            quantity
            customAttributes {
              key
              value
            }
          }
        }
      }
    }
  `;

  const result = await shopifyRequest(query, { id: orderGID });
  return result?.data?.order || null;
}

async function getInventoryItemId(variantId) {
  const query = `
    query GetVariant($id: ID!) {
      productVariant(id: $id) {
        inventoryItem {
          id
        }
      }
    }
  `;

  const variantGID = `gid://shopify/ProductVariant/${variantId}`;
  const result = await shopifyRequest(query, { id: variantGID });
  return result?.data?.productVariant?.inventoryItem?.id || null;
}

async function shopifyRequest(query, variables) {
  const response = await axios.post(
    `https://${SHOP}/admin/api/2024-07/graphql.json`,
    { query, variables },
    {
      headers: {
        "X-Shopify-Access-Token": ACCESS_TOKEN,
        "Content-Type": "application/json",
      },
    }
  );
  return response.data;
}
