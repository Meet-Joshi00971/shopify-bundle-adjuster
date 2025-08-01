const express = require("express");
const axios = require("axios");
const app = express();
app.use(express.json());

const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const SHOPIFY_STORE = process.env.SHOPIFY_STORE_DOMAIN;
const LOCATION_ID = "gid://shopify/Location/108654461258";

app.post("/bundle-adjust", async (req, res) => {
  try {
    const rawOrderId = req.body.order_id;
    const orderId = rawOrderId.replace("gid://shopify/Order/", "");
    console.log("[Server] Received order ID:", orderId);

    const orderResponse = await axios.get(
      `https://${SHOPIFY_STORE}/admin/api/2023-10/orders/${orderId}.json`,
      {
        headers: {
          "X-Shopify-Access-Token": ADMIN_TOKEN,
        },
      }
    );

    const order = orderResponse.data.order;
    const adjustments = [];

    for (const item of order.line_items) {
      const bundleProp = item.properties.find((p) => p.name === "_BundleComponents");
      if (!bundleProp) continue;

      console.log("[Bundle] Found _BundleComponents:", bundleProp.value);
      const components = bundleProp.value.split(",").map((c) => c.trim());

      for (const component of components) {
        const [inventoryItemIdRaw, quantityRaw] = component.split("|").map((x) => x.trim());
        const inventoryItemId = `gid://shopify/InventoryItem/${inventoryItemIdRaw}`;
        const deltaQty = -parseInt(quantityRaw, 10);

        adjustments.push({
          inventoryItemId: inventoryItemId,
          delta: deltaQty,
          locationId: LOCATION_ID,
          ledgerDocumentUri: "https://yourdomain.com/ledger",
        });
      }
    }

    if (adjustments.length === 0) {
      console.log("[INFO] No bundle adjustments found.");
      return res.status(200).json({ message: "No bundles to adjust." });
    }

    const mutation = `
      mutation inventoryAdjustQuantities($input: InventoryAdjustQuantitiesInput!) {
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

    const variables = {
      input: {
        name: "Bundle Inventory Adjustment",
        reason: "correction",
        changes: adjustments,
      },
    };

    const gqlRes = await axios.post(
      `https://${SHOPIFY_STORE}/admin/api/2023-10/graphql.json`,
      {
        query: mutation,
        variables,
      },
      {
        headers: {
          "X-Shopify-Access-Token": ADMIN_TOKEN,
          "Content-Type": "application/json",
        },
      }
    );

    const gqlData = gqlRes.data;
    console.log("[DEBUG] GraphQL raw response:", JSON.stringify(gqlData, null, 2));

    if (gqlData.errors) {
      console.error("[GraphQL top-level errors]", gqlData.errors);
      return res.status(500).send("GraphQL top-level error");
    }

    if (gqlData.data.inventoryAdjustQuantities.userErrors.length > 0) {
      console.error("[GraphQL user errors]", gqlData.data.inventoryAdjustQuantities.userErrors);
      return res.status(500).send("User errors during inventory adjustment");
    }

    console.log("[✅ SUCCESS] Inventory adjusted successfully!");
    return res.status(200).send("Inventory adjusted.");
  } catch (err) {
    console.error("[❌ ERROR]", err.message);
    return res.status(500).send("Error adjusting inventory");
  }
});

app.listen(process.env.PORT || 10000, () => {
  console.log("🚀 Server listening...");
});
