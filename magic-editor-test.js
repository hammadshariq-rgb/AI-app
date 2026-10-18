// A stock report. Run it with:  node magic-editor-test.js
//
// It prints the wrong answer. Highlight the function below and ask Magic
// Editor to fix it.

const WAREHOUSE = {
  'widget-a': 12,
  'widget-b': 7,
  'widget-c': 30,
  'widget-d': 5,
};

// Pretends to be a database call.
function fetchStock(id) {
  return new Promise((resolve) => {
    setTimeout(() => resolve(WAREHOUSE[id] ?? 0), 20);
  });
}

// ── highlight from here ──────────────────────────────────────────────────────
async function totalStock(ids) {
  let total = 0;

  ids.forEach(async (id) => {
    const count = await fetchStock(id);
    total += count;
  });

  return total;
}
// ── to here ──────────────────────────────────────────────────────────────────

(async () => {
  const ids = Object.keys(WAREHOUSE);
  const total = await totalStock(ids);

  console.log('ids counted :', ids.join(', '));
  console.log('total stock :', total);
  console.log('expected    : 54');
  console.log(total === 54 ? 'PASS' : 'FAIL - it should be 54');
})();
