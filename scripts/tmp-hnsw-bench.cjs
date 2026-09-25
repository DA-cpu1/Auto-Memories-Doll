// 测量一次 VectorIndex 实例化（含 HNSW 从 SQLite 重建）的真实耗时
process.env.VECTOR_BACKEND = process.env.VECTOR_BACKEND || "hnsw";
const { VectorIndex } = require("../src/lib/vector/index");

async function main() {
  const t0 = Date.now();
  const index = new VectorIndex();
  const t1 = Date.now();
  const backend = index.getBackendName();
  // 触发一次真实查询路径看是否还有惰性开销
  const t2 = Date.now();
  index.close();
  const t3 = Date.now();
  console.log(
    JSON.stringify({
      instantiateMs: t1 - t0,
      postMs: t3 - t2,
      backend,
    }),
  );
}

main().catch((e) => {
  console.error("bench failed:", e.message);
  process.exit(1);
});
