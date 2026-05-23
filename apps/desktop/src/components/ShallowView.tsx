interface ShallowViewProps {
  title: string;
  eyebrow: string;
  description: string;
  stats: Array<{ label: string; value: string }>;
}

export function ShallowView({ title, eyebrow, description, stats }: ShallowViewProps) {
  return (
    <section className="shallow-view" aria-labelledby={`${title}-title`}>
      <header className="topbar">
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h2 id={`${title}-title`}>{title}</h2>
        </div>
      </header>
      <p className="lead-copy">{description}</p>
      <div className="stat-grid">
        {stats.map((stat) => (
          <article className="stat-card" key={stat.label}>
            <strong>{stat.value}</strong>
            <span>{stat.label}</span>
          </article>
        ))}
      </div>
    </section>
  );
}
