import { AskPanel } from "@/components/ask/AskPanel";

export default function HomePage() {
  return (
    <div className="home-page page-frame">
      <header className="home-intro">
        <h1>你想知道什么？</h1>
        <p>直接提问，或检索一条记录。回答会标出它所依据的来源。</p>
      </header>
      <AskPanel />
    </div>
  );
}
