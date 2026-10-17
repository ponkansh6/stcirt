interface EmptyStateProps {
  title: string;
  description?: string;
}

export function EmptyState({ title, description }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center p-8 text-center space-y-4 bg-surface shadow-card rounded-card border border-border/60 my-auto motion-safe:animate-rise">
      <h2 className="text-xl font-bold text-balance">{title}</h2>
      {description && <p className="text-muted text-pretty">{description}</p>}
    </div>
  );
}
