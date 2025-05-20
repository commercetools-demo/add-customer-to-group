import { Request, Response } from 'express';
import { createApiRoot } from '../client/create.client';
import CustomError from '../errors/custom.error';
import { logger } from '../utils/logger.utils';
import { LineItem, Order } from '@commercetools/platform-sdk';

// Parse the mapping from environment variable
let productTypeToCustomerGroupMap: Record<string, string[]> = {};
try {
  const mapString = process.env.CGROUP_TO_PRODUCT_TYPE_MAP || '{}';
  productTypeToCustomerGroupMap = JSON.parse(mapString);
  logger.info('Successfully parsed product type to customer group mapping');
} catch (error) {
  try {
  const mapString = process.env.CGROUP_TO_PRODUCT_TYPE_MAP || '{}';

    // If the first parse fails, try unescaping the string first
    // This handles double-encoded JSON strings like "{\"key\":\"value\"}"
    const unescaped = mapString.replace(/\\"/g, '"');
    productTypeToCustomerGroupMap =  JSON.parse(unescaped);
  } catch (nestedError) {
    // If both parsing attempts fail, log the error and return an empty object
    logger.error(`Failed to parse CGROUP_TO_PRODUCT_TYPE_MAP`);
    productTypeToCustomerGroupMap = {};
  }
}

console.log(productTypeToCustomerGroupMap);

/**
 * Exposed event POST endpoint.
 * Receives the Pub/Sub message and works with it
 *
 * @param {Request} request The express request
 * @param {Response} response The express response
 * @returns
 */
export const post = async (request: Request, response: Response) => {
  // Check request body
  if (!request.body) {
    logger.error('Missing request body.');
    throw new CustomError(400, 'Bad request: No Pub/Sub message was received');
  }

  // Check if the body comes in a message
  if (!request.body.message) {
    logger.error('Missing body message');
    throw new CustomError(400, 'Bad request: Wrong No Pub/Sub message format');
  }

  // Receive the Pub/Sub message
  const pubSubMessage = request.body.message;

  // Decode the Pub/Sub message data
  const decodedData = pubSubMessage.data
    ? Buffer.from(pubSubMessage.data, 'base64').toString().trim()
    : undefined;


  if (!decodedData) {
    throw new CustomError(400, 'Bad request: No data in the Pub/Sub message');
  }

  const jsonData = JSON.parse(decodedData);

  logger.info(jsonData);

  // Skip if message type is not OrderCreated
  if (jsonData.type !== 'OrderCreated') {
    logger.info(`Skipping message of type: ${jsonData.type}`);
    response.status(204).send();
    return;
  }

  try {
    const order: Order = jsonData.order;
    
    if (!order) {
      logger.error('No order data in the message');
      throw new CustomError(400, 'Bad request: No order data in the message');
    }

    // Check if order has a customer
    if (!order.customerId) {
      logger.info('Order has no customer, skipping');
      response.status(204).send();
      return;
    }

    const customerId = order.customerId;

    // Check if any line item matches a product ID in our mapping
    if (!order.lineItems || order.lineItems.length === 0) {
      logger.info('Order has no line items, skipping');
      response.status(204).send();
      return;
    }

    // Find the relevant customer group based on ordered products
    let targetCustomerGroupId: string | null = null;

    // For each customer group in our mapping
    for (const [customerGroupId, productTypeIds] of Object.entries(productTypeToCustomerGroupMap)) {
      // Check if any product in the order matches the product types for this customer group
      const hasMatchingProduct = order.lineItems.some((lineItem: LineItem) => 
        productTypeIds.includes(lineItem.productType?.id)
      );

      if (hasMatchingProduct) {
        targetCustomerGroupId = customerGroupId;
        break;
      }
    }

    // If no matching product found, skip
    if (!targetCustomerGroupId) {
      logger.info('No matching product found in order for any configured customer group, skipping');
      response.status(204).send();
      return;
    }

    // Fetch customer details
    const customer = await createApiRoot()
      .customers()
      .withId({ ID: customerId })
      .get()
      .execute();

    // If customer already belongs to the target group, skip
    if (customer.body.customerGroup?.id === targetCustomerGroupId) {
      logger.info('Customer already belongs to the target group, skipping');
      response.status(204).send();
      return;
    }

    // Add customer to the customer group
    await createApiRoot()
      .customers()
      .withId({ ID: customerId })
      .post({
        body: {
          version: customer.body.version,
          actions: [
            {
              action: 'setCustomerGroup',
              customerGroup: {
                typeId: 'customer-group',
                id: targetCustomerGroupId
              }
            }
          ]
        }
      })
      .execute();

    logger.info(`Added customer ${customerId} to customer group ${targetCustomerGroupId}`);
  } catch (error) {
    throw new CustomError(400, `Bad request: ${error}`);
  }

  // Return the response for the client
  response.status(204).send();
};
