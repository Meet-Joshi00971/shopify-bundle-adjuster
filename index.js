const express = require("express");
const axios = require("axios");
const bodyParser = require("body-parser");

const app = express();
app.use(bodyParser.json());

// ENV VARIABLES (SET IN RENDER)
const SHOPIFY_STORE = process.env.SHOPIFY_STORE; // e.g. my-store.myshopify.com
const ADMIN_TOKEN = process.env.ADMIN_TOKEN; // starts with shpat_

app.post("/bundle-adjust", async (req, res) => {
  const orderId = req.body.order_id;
  if (!orderId) return res.status(400).send("Missing order_id");

  try {
    // Step 1: Get full order
    const orderRes = await axios.get(
      `https://${SHOPIFY_STORE}/admin/api/2023-10/orders/${orderId}.json`,
      {
        headers: {
          "X-Shopify-Access-Token": ADMIN_TOKEN,
        },
      }
    );

    const lineItems = orderRes.data.order.line_items;

    // Step 2: Parse _BundleComponents
    const adjustments = [];

    for (let item of lineItems) {
      const props = item.properties || [];
      const bundleProp = props.find((p) => p.name === "_BundleComponents");

      if (bundleProp) {
        const components = bundleProp.value.split(", ");
        components.forEach((entry) => {
          const [inventoryItemId, quantityStr] = entry.split("|").map((v) => v.trim());
          adjustments.push({
            inventoryItemId: `gid://shopify/InventoryItem/${inventoryItemId}`,
            availableDelta: -parseInt(quantityStr, 10),
          });
        });
      }
    }

    // Step 3: Send GraphQL mutation
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

      console.log("Inventory adjusted:", gqlRes.data);
      return res.status(200).send("Inventory adjusted");
    } else {
      return res.status(200).send("No bundle components found");
    }
  } catch (err) {
    console.error(err.response?.data || err.message);
    return res.status(500).send("Error adjusting inventory");
  }
});

app.get("/", (_, res) => {
  res.send("Bundle Adjuster is running");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
