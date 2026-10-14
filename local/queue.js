import { createHash } from "node:crypto";

export class Queue {
  constructor(store) { this.store = store; this.lock = Promise.resolve(); }
  transact(fn) {
    const operation = this.lock.then(async () => {
      const data = await this.store.read("queue", { jobs: [], seen: {} });
      const before = JSON.stringify(data);
      const result = await fn(data);
      if (JSON.stringify(data) !== before) await this.store.write("queue", data);
      return result;
    });
    this.lock = operation.catch(() => {});
    return operation;
  }
  async enqueue(raw, event) {
    return this.transact(data => {
      const now = Date.now();
      for (const [id, time] of Object.entries(data.seen)) if (time < now - 7 * 86400000) delete data.seen[id];
      const id = createHash("sha256").update(raw).digest("hex");
      if (data.seen[id]) return false;
      if (data.jobs.length >= 100) throw new Error("queue_full");
      data.seen[id] = now;
      data.jobs.push({ id, event, status: "pending", created: now });
      return true;
    });
  }
  async next() {
    return this.transact(data => {
      const job = data.jobs.find(j => ["pending", "answered"].includes(j.status));
      if (job) { job.status = job.answer ? "delivering" : "running"; return structuredClone(job); }
      return null;
    });
  }
  async answer(id, answer) {
    await this.transact(data => { const j = data.jobs.find(j => j.id === id); j.answer = answer; j.status = "answered"; });
  }
  async finish(id) { await this.transact(data => { data.jobs = data.jobs.filter(j => j.id !== id); }); }
  async fail(id) { await this.transact(data => { const j = data.jobs.find(j => j.id === id); if (j) { j.status = "uncertain"; delete j.event; delete j.answer; } }); }
  // A crash during inference or message delivery has an ambiguous outcome.
  // Do not automatically repeat it and consume the allowance/send twice.
  async recover() {
    await this.transact(data => {
      data.jobs = data.jobs.filter(j => j.status !== "uncertain");
      for (const j of data.jobs) if (["running", "delivering"].includes(j.status)) { j.status = "uncertain"; delete j.event; delete j.answer; }
    });
  }
}
