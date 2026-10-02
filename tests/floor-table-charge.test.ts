/**
 * Integration Test: Floor-level table-use charge
 *
 * Verifies the complete chain:
 * 1) Floor charge definition and validation
 * 2) Dine-in order snapshots the floor charge at creation
 * 3) Order total includes the charge without changing product subtotal
 * 4) Adding items and fixed-amount discounts preserve the snapshot
 * 5) Existing bills stay synchronized with the order
 * 6) Moving an open order to another table does not rewrite the snapshot
 * 7) Split checks allocate the charge and preserve the aggregate
 * 8) Dine-in -> takeaway clears the table-use charge
 * 9) Floor rename/delete keep the configuration coherent
 *
 * Usage: node tests/run-electron-node-test.cjs tests/floor-table-charge.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-table-charge-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return {
      app: {
        isPackaged: true,
        getPath: () => testDir,
        getVersion: () => 'test',
      },
    };
  }
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb,
  createApp,
  startServer,
  seedOwnerUser,
  seedCategory,
  seedProduct,
  api,
  assert,
  assertEqual,
  assertIncludes,
  closeDatabase,
} = require('./helpers/test-setup');

const { tableRoutes } = require('../main/routes/tables');
const { orderRoutes } = require('../main/routes/orders');
const { billRoutes } = require('../main/routes/bills');

async function main() {
  console.log('Integration Test: Floor-level Table-use Charge');
  console.log('='.repeat(50));

  const db = initTestDb();
  const { authHeader } = seedOwnerUser(db);
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('split_checks_enabled', 'true', CURRENT_TIMESTAMP)").run();

  seedCategory(db, 'cat-table-charge', 'Table Charge Test Menu');
  seedProduct(db, 'prod-table-charge-a', 'cat-table-charge', 'Coffee', 1000);
  seedProduct(db, 'prod-table-charge-b', 'cat-table-charge', 'Cake', 2000);
  seedProduct(db, 'prod-table-charge-c', 'cat-table-charge', 'Brunch', 3000);

  const insertTable = db.prepare(
    "INSERT OR REPLACE INTO tables (id, number, capacity, status, floor, created_at, updated_at) VALUES (?, ?, ?, 'available', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
  );
  insertTable.run('tbl-charge-a', 'C-1', 4, 'First Floor');
  insertTable.run('tbl-charge-b', 'C-2', 4, 'Second Floor');
  insertTable.run('tbl-charge-free', 'C-3', 4, 'No Charge Floor');

  const app = createApp({
    '/api/tables': tableRoutes,
    '/api/orders': orderRoutes,
    '/api/bills': billRoutes,
  });
  const { baseUrl, server } = await startServer(app);

  try {
    console.log('\n1. Schema and floor-charge definition');

    const orderColumns = db.prepare('PRAGMA table_info(orders)').all().map((row: any) => row.name);
    assert(orderColumns.includes('table_charge'), 'orders schema contains table_charge');
    const billColumns = db.prepare('PRAGMA table_info(bills)').all().map((row: any) => row.name);
    assert(billColumns.includes('table_charge'), 'bills schema contains table_charge');
    assert(
      !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'floor_table_charges'").get(),
      'floor_table_charges table exists',
    );

    const saveCharge = await api(baseUrl, '/api/tables/floor-charges/First%20Floor', {
      method: 'PUT',
      headers: authHeader,
      body: { default_table_charge: 500 },
    });
    assertEqual(saveCharge.status, 200, 'floor charge is created');
    assertEqual(saveCharge.data.floorCharge.floor, 'First Floor', 'saved charge keeps floor name');
    assertEqual(saveCharge.data.floorCharge.default_table_charge, 500, 'saved charge amount is 500');

    const invalidNegative = await api(baseUrl, '/api/tables/floor-charges/First%20Floor', {
      method: 'PUT',
      headers: authHeader,
      body: { default_table_charge: -1 },
    });
    assertEqual(invalidNegative.status, 400, 'negative floor charge is rejected');
    assertEqual(invalidNegative.data.code, 'FLOOR_TABLE_CHARGE_INVALID', 'negative charge has stable validation code');

    const invalidInfinity = await api(baseUrl, '/api/tables/floor-charges/First%20Floor', {
      method: 'PUT',
      headers: authHeader,
      body: { default_table_charge: 'Infinity' },
    });
    assertEqual(invalidInfinity.status, 400, 'Infinity floor charge is rejected');

    const readCharges = await api(baseUrl, '/api/tables/floor-charges', { headers: authHeader });
    assertEqual(readCharges.status, 200, 'floor charges are readable');
    assertEqual(
      readCharges.data.floorCharges.find((row: any) => row.floor === 'First Floor').default_table_charge,
      500,
      'GET returns configured floor charge',
    );

    console.log('\n2. Dine-in order snapshots the floor charge');

    const firstOrderRes = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: authHeader,
      body: {
        type: 'dine_in',
        table_id: 'tbl-charge-a',
        items: [{ product_id: 'prod-table-charge-a', quantity: 1 }],
      },
    });
    assertEqual(firstOrderRes.status, 201, 'dine-in order is created');
    const firstOrder = firstOrderRes.data.order;
    assertEqual(firstOrder.table_charge, 500, 'order snapshots 500 table charge');
    assertEqual(firstOrder.subtotal, 1000, 'table charge does not inflate product subtotal');
    assertEqual(firstOrder.total, 1500, 'table charge is included in order total');

    const firstBillRes = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      headers: authHeader,
      body: { order_id: firstOrder.id },
    });
    assertEqual(firstBillRes.status, 201, 'bill is generated');
    assertEqual(firstBillRes.data.bill.table_charge, 500, 'bill snapshots table charge');
    assertEqual(firstBillRes.data.bill.total, 1500, 'bill total includes table charge');

    console.log('\n3. Changing the floor setting does not rewrite an open order');

    const updateFloorCharge = await api(baseUrl, '/api/tables/floor-charges/First%20Floor', {
      method: 'PUT',
      headers: authHeader,
      body: { default_table_charge: 900 },
    });
    assertEqual(updateFloorCharge.status, 200, 'floor charge can be changed');

    const addItemsRes = await api(baseUrl, `/api/orders/${firstOrder.id}/items`, {
      method: 'POST',
      headers: authHeader,
      body: {
        items: [{ product_id: 'prod-table-charge-b', quantity: 1 }],
      },
    });
    assertEqual(addItemsRes.status, 200, 'adding an item to the open order succeeds');
    const afterAdd = addItemsRes.data.order;
    assertEqual(afterAdd.table_charge, 500, 'existing order keeps original 500 table charge');
    assertEqual(afterAdd.subtotal, 3000, 'subtotal becomes 3000 after adding second item');
    assertEqual(afterAdd.total, 3500, 'new total still uses original 500 table charge');

    console.log('\n4. Fixed-amount discount leaves table charge outside the discount base');

    const discountRes = await api(baseUrl, `/api/orders/${firstOrder.id}/discount`, {
      method: 'PATCH',
      headers: authHeader,
      body: {
        discount_type: 'amount',
        discount_value: 1000,
        discount_reason: 'table-charge regression test',
      },
    });
    assertEqual(discountRes.status, 200, 'fixed-amount discount applies');
    assertEqual(discountRes.data.order.discount_amount, 1000, 'discount amount is 1000');
    assertEqual(discountRes.data.order.table_charge, 500, 'discount does not change table charge');
    assertEqual(discountRes.data.order.subtotal, 3000, 'discount does not change subtotal field');
    assertEqual(discountRes.data.order.total, 2500, 'total = 3000 - 1000 + 500');

    const syncedBill = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      headers: authHeader,
      body: { order_id: firstOrder.id },
    });
    assertEqual(syncedBill.status, 200, 'existing bill is re-synced');
    assertEqual(syncedBill.data.bill.table_charge, 500, 're-synced bill keeps table charge');
    assertEqual(syncedBill.data.bill.total, 2500, 're-synced bill total matches order');

    console.log('\n5. Moving the order to another floor does not rewrite the snapshot');

    const moveRes = await api(baseUrl, '/api/tables/tbl-charge-a/move-order', {
      method: 'POST',
      headers: authHeader,
      body: { target_table_id: 'tbl-charge-free' },
    });
    assertEqual(moveRes.status, 200, 'open order can move to another table');
    assertEqual(moveRes.data.order.table_id, 'tbl-charge-free', 'order now points to the other floor table');
    assertEqual(moveRes.data.order.table_charge, 500, 'moving order does not rewrite original table charge');

    console.log('\n6. Split checks allocate table charge without losing money');

    const secondFloorCharge = await api(baseUrl, '/api/tables/floor-charges/Second%20Floor', {
      method: 'PUT',
      headers: authHeader,
      body: { default_table_charge: 400 },
    });
    assertEqual(secondFloorCharge.status, 200, 'second floor charge is configured');

    const chargedSplitOrderRes = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: authHeader,
      body: {
        type: 'dine_in',
        table_id: 'tbl-charge-b',
        items: [
          { product_id: 'prod-table-charge-a', quantity: 1 },
          { product_id: 'prod-table-charge-c', quantity: 1 },
        ],
      },
    });
    assertEqual(chargedSplitOrderRes.status, 201, 'charged split-test order is created');
    const chargedSplitOrder = chargedSplitOrderRes.data.order;
    assertEqual(chargedSplitOrder.table_charge, 400, 'charged split order snapshots 400');

    const chargedBill = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      headers: authHeader,
      body: { order_id: chargedSplitOrder.id },
    });
    assertEqual(chargedBill.status, 201, 'charged split-test bill is generated');

    const itemA = chargedSplitOrder.items.find((item: any) => item.product_id === 'prod-table-charge-a');
    const itemC = chargedSplitOrder.items.find((item: any) => item.product_id === 'prod-table-charge-c');

    const splitRes = await api(baseUrl, `/api/bills/${chargedBill.data.bill.id}/split-check`, {
      method: 'POST',
      headers: authHeader,
      body: {
        checks: [
          { label: 'Guest 1', items: [{ order_item_id: itemA.id, quantity: 1 }] },
          { label: 'Guest 2', items: [{ order_item_id: itemC.id, quantity: 1 }] },
        ],
      },
    });
    assertEqual(splitRes.status, 201, 'charged order split succeeds');
    assertEqual(splitRes.data.bills.length, 2, 'two split bills are returned');
    const splitTableCharges = splitRes.data.bills.map((bill: any) => Number(bill.table_charge));
    assertEqual(splitTableCharges.reduce((sum: number, amount: number) => sum + amount, 0), 400, 'split table charges sum to original 400');
    assertEqual(splitTableCharges[0], 100, '1000-value item receives 100 of the 400 table charge');
    assertEqual(splitTableCharges[1], 300, '3000-value item receives 300 of the 400 table charge');
    const splitTotals = splitRes.data.bills.map((bill: any) => Number(bill.total));
    assertEqual(splitTotals.reduce((sum: number, total: number) => sum + total, 0), chargedBill.data.bill.total, 'split totals preserve the original bill total');

    console.log('\n7. Dine-in to takeaway clears table-use charge');

    const convertRes = await api(baseUrl, `/api/orders/${firstOrder.id}/convert-to-takeaway`, {
      method: 'PATCH',
      headers: authHeader,
      body: {},
    });
    assertEqual(convertRes.status, 200, 'dine-in order converts to takeaway');
    assertEqual(convertRes.data.order.type, 'takeaway', 'order type becomes takeaway');
    assertEqual(convertRes.data.order.table_id, null, 'takeaway order has no table');
    assertEqual(convertRes.data.order.table_charge, 0, 'takeaway conversion clears table charge');
    assertEqual(convertRes.data.order.total, 2000, 'takeaway conversion removes table charge from order total');

    const convertedBill = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      headers: authHeader,
      body: { order_id: firstOrder.id },
    });
    assertEqual(convertedBill.status, 200, 'converted order bill remains readable');
    assertEqual(convertedBill.data.bill.table_charge, 0, 'converted unpaid bill clears table charge');
    assertEqual(convertedBill.data.bill.total, 2000, 'converted unpaid bill matches new order total');

    console.log('\n8. Floor rename/delete keep configuration coherent');

    const renameRes = await api(baseUrl, '/api/tables/floors/No%20Charge%20Floor', {
      method: 'PATCH',
      headers: authHeader,
      body: { newName: 'Third Floor' },
    });
    assertEqual(renameRes.status, 200, 'floor rename succeeds');

    const chargeForRename = await api(baseUrl, '/api/tables/floor-charges/Third%20Floor', {
      method: 'PUT',
      headers: authHeader,
      body: { default_table_charge: 700 },
    });
    assertEqual(chargeForRename.status, 200, 'renamed floor accepts a charge');

    const renameAgain = await api(baseUrl, '/api/tables/floors/Third%20Floor', {
      method: 'PATCH',
      headers: authHeader,
      body: { newName: 'Fourth Floor' },
    });
    assertEqual(renameAgain.status, 200, 'second floor rename succeeds');

    const renamedForward = await api(baseUrl, '/api/tables/floor-charges/Fourth%20Floor', { headers: authHeader });
    assertEqual(
      renamedForward.data.floorCharges.find((row: any) => row.floor === 'Fourth Floor').default_table_charge,
      700,
      'floor charge follows a floor rename when destination has no charge',
    );

    const deleteRes = await api(baseUrl, '/api/tables/floors/Fourth%20Floor', {
      method: 'DELETE',
      headers: authHeader,
    });
    assertEqual(deleteRes.status, 200, 'floor delete succeeds');
    const afterDelete = await api(baseUrl, '/api/tables/floor-charges', { headers: authHeader });
    assertEqual(
      (afterDelete.data.floorCharges || []).some((row: any) => row.floor === 'Fourth Floor'),
      false,
      'deleting a floor removes its default table charge',
    );

    console.log('\n✅ All floor table charge tests passed');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

main()
  .then(() => {
    closeDatabase();
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
  })
  .catch((error) => {
    try { closeDatabase(); } catch { }
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
    console.error(error);
    process.exit(1);
  });
