import { HomeLayout } from 'fumadocs-ui/layouts/home';
import { baseOptions } from '@/lib/layout.shared';

export default function Layout({ children }: LayoutProps<'/'>) {
  return <HomeLayout {...baseOptions()} className="stack-home-layout"><a className="skip-link" href="#main-content">Skip to content</a>{children}</HomeLayout>;
}
