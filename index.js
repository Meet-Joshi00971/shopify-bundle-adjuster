const express = require("express");
const axios = require("axios");
const bodyParser = require("body-parser");

const app = express();
app.use(bodyParser.json());

// 🌐 ENV VARIABLES in Render dashboard
const SHOPIFY_STORE = process.env.SHOPIFY_STORE; // e.g. "your-store.myshopify.com"
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;     // e.g. "shpat_abc123..."

app.post("/bundle-adjust", async (req, res) => {
  try {
    const fullGid = req.body.order_id;
    if (!fullGid) return res.status(400).send("Missing order_id");

    const orderId = fullGid.split("/").pop();
    console.log(`[Server] Received order ID: ${orderId}`);

    // 🛒 Step 1: Get full order
    const orderRes = await axios.get(
      `https://${SHOPIFY_STORE}/admin/api/2023-10/orders/${orderId}.json`,
      {
        headers: {
          "X-Shopify-Access-Token": ADMIN_TOKEN,
        },
      }
    );

    const order = orderRes.data.order;
    const lineItems = order.line_items;

    // 🧭 Step 2: Detect locationId
    const locationsRes = await axios.get(
      `https://${SHOPIFY_STORE}/admin/api/2023-10/locations.json`,
      {
        headers: {
          "X-Shopify-Access-Token": ADMIN_TOKEN,
        },
      }
    );

    const primaryLocation = locationsRes.data.locations[0];
    if (!primaryLocation) throw new Error("No location found in store.");

    const locationId = `gid://shopify/Location/${primaryLocation.id}`;
    console.log(`[Location] Using location ID: ${locationId}`);

    // 🧩 Step 3: Build inventory adjustments
    const adjustments = [];

    for (const item of lineItems) {
      const props = item.properties || [];
      const bundleProp = props.find((p) => p.name === "_BundleComponents");

      if (bundleProp) {
        console.log(`[Bundle] Found _BundleComponents: ${bundleProp.value}`);
        const components = bundleProp.value.split(", ");
        for (const component of components) {
          const [inventoryItemIdRaw, quantityRaw] = component.split("|").map((v) => v.trim());
          if (!inventoryItemIdRaw || !quantityRaw) continue;

          const deltaQty = -parseInt(quantityRaw, 10);

          adjustments.push({
            inventoryItemId: `gid://shopify/InventoryItem/${inventoryItemIdRaw}`,
            delta: deltaQty,
            locationId: locationId,
          });
        }
      }
    }

    // 🛠️ Step 4: Adjust inventory
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

      // 🧪 LOG GRAPHQL RESPONSE
      console.log("[DEBUG] GraphQL raw response:", JSON.stringify(gqlRes.data, null, 2));

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
      console.log("[ℹ️] No bundle components found.");
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
