function createPinOcrCache({ limit = 64, load } = {}) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('OCR cache limit must be a positive integer');
  if (typeof load !== 'function') throw new Error('OCR cache loader is required');
  const records = new Map();

  function touch(key, record) {
    records.delete(key);
    records.set(key, record);
  }

  function trim() {
    while (records.size > limit) records.delete(records.keys().next().value);
  }

  function get(key, input) {
    const existing = records.get(key);
    if (existing) {
      touch(key, existing);
      return existing.promise;
    }
    const record = {};
    record.promise = Promise.resolve()
      .then(() => load(input))
      .catch((error) => {
        if (records.get(key) === record) records.delete(key);
        throw error;
      });
    records.set(key, record);
    trim();
    return record.promise;
  }

  return {
    get,
    delete: (key) => records.delete(key),
    clear: () => records.clear(),
    has: (key) => records.has(key),
    get size() { return records.size; },
  };
}

module.exports = { createPinOcrCache };
