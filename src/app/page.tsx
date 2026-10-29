export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center gap-4 px-4 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">Food Ambassador</h1>
      <p className="text-muted text-base">
        Food operations platform — procurement, inventory, recipes, food safety and traceability.
      </p>
      <p className="text-muted text-sm">
        This build contains the platform foundation (Milestone 0). Sign-in and organization access
        arrive in Milestone 1.
      </p>
    </main>
  );
}
