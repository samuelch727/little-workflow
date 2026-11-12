import { StackIcon } from '@/components/stack-icon';

export function StackMark({ className = '', size = 32 }: { className?: string; size?: number }) {
  return <StackIcon name="brand" size={size} className={className} />;
}

export function StackBrand() {
  return <span className="stack-brand"><StackMark /><span>Little Stack</span><span className="stack-brand-label">docs</span></span>;
}
