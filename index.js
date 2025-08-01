const express = require("express");
const axios = require("axios");
const bodyParser = require("body-parser");

const app = express();
app.use(bodyParser.json());

// 🚨 SET THESE IN RENDER ENV VARIABLES
const SHOPIFY_STORE = process.env.SHOPIFY_STORE; // e.g. "your-store.myshopify.com"
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;     // e.g. "shpat_abc123..."

app.post("/bundle-adjust", async (req, res) => {
  try {
    const fullGid = req.body.order_id;
    if (!fullGid) return res.status(400).send("Missing order_id");

    // ✅ Extract plain numeric ID from Shopify GID
    const orderId = fullGid.split("/").pop();
    console.log(`[Server] Received order ID: ${orderId}`);

    // 🛒 Step 1: Fetch full order with line item properties
    const orderRes = await axios.get(
      `https://${SHOPIFY_STORE}/admin/api/2023-10/orders/${orderId}.json`,
      {
        headers: {
          "X-Shopify-Access-Token": ADMIN_TOKEN,
        },
      }
    );

    const lineItems = orderRes.data.order.line_items;
    const adjustments = [];

    // 🧩 Step 2: Parse `_BundleComponents` from line item properties
    for (const item of lineItems) {
      const props = item.properties || [];
      const bundleProp = props.find((p) => p.name === "_BundleComponents");

      if (bundleProp) {
        console.log(`[Bundle] Found _BundleComponents: ${bundleProp.value}`);

        const components = bundleProp.value.split(", ");
        for (const component of components) {
          const [inventoryItemIdRaw, quantityRaw] = component.split("|").map((v) => v.trim());

          if (!inventoryItemIdRaw || !quantityRaw) continue;

          adjustments.push({
            inventoryItemId: `gid://shopify/InventoryItem/${inventoryItemIdRaw}`,
            availableDelta: -parseInt(quantityRaw, 10),
          });
        }
      }
    }

    // 🚀 Step 3: Send inventoryAdjustQuantities mutation
    if (adjustments.length > 0) {
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
          reason: "bundle component deduction",
          name: "BundleFlow",
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

      // 🪵 DEBUG FULL GRAPHQL RESPONSE
      console.log("[DEBUG] GraphQL raw response:", JSON.stringify(gqlRes.data, null, 2));

      // 🧯 HANDLE GRAPHQL ERRORS
      if (gqlRes.data.errors) {
        console.error("[GraphQL top-level errors]", JSON.stringify(gqlRes.data.errors, null, 2));
        return res.status(500).send("GraphQL top-level error");
      }

      const result = gqlRes.data.data;

      if (!result || !result.inventoryAdjustQuantities) {
        console.error("[GraphQL missing inventoryAdjustQuantities]", JSON.stringify(result, null, 2));
        return res.status(500).send("Missing inventoryAdjustQuantities result");
      }

      const userErrors = result.inventoryAdjustQuantities.userErrors;

      if (userErrors && userErrors.length > 0) {
        console.error("[GraphQL userErrors]", JSON.stringify(userErrors, null, 2));
        return res.status(500).send("Inventory adjustment failed (userErrors)");
      }

      console.log("[✅ SUCCESS] Inventory adjusted successfully!");
      return res.status(200).send("Inventory adjusted");
    } else {
      console.log("[ℹ️] No bundle components found in this order.");
      return res.status(200).send("No bundle components found");
    }
  } catch (err) {
    console.error("[💥 ERROR]", err.response?.data || err.message);
    return res.status(500).send("Error adjusting inventory");
  }
});

app.get("/", (_, res) => {
  res.send("✅ Bundle Adjuster is running.");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
