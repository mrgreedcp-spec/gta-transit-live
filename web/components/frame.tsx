import type { ReactNode } from 'react';
import { BRAND, Locale, PagePath, REVIEW_DATE, pageMeta, pageUrl, tr } from '@/lib/content';
import { Icon } from './icon';
import { LegacyLaunch } from './legacy-launch';

export function Frame({ children, locale, path }: { children: ReactNode; locale: Locale; path: PagePath }) {
  const zh = locale === 'zh';
  const nav = [
    ['routes', zh ? '路线指南' : 'Journey guides', zh ? '路线指南' : 'Journeys'],
    ['fare-calculator', zh ? '票价计算器' : 'Fare calculator', zh ? '票价计算' : 'Fares'],
    ['one-fare', 'One Fare', 'One Fare'],
    ['operators', zh ? '交通机构' : 'Operators', zh ? '交通机构' : 'Operators'],
  ];
  return <>
    <a className="skip-link" href="#main">{zh ? '跳至主要内容' : 'Skip to content'}</a>
    <div className="topline"><div className="container"><span>{zh ? '大多伦多地区的独立公交指南' : 'Your independent guide to transit in the Greater Toronto Area'}</span><a href={pageUrl('sources', locale)}>{zh ? '官方来源 · 清晰说明' : 'Official sources. Clearer journeys.'}</a></div></div>
    <header className="header"><div className="container header-inner">
      <a className="brand" href={pageUrl('', locale)} aria-label={zh ? 'GTA Transit Live 首页' : 'GTA Transit Live home'}><span className="brand-mark"><Icon name="train" size={25}/></span><span>GTA Transit <strong>Live</strong><small>{zh ? '公交出行指南' : 'THE TRANSIT GUIDE'}</small></span></a>
      <nav className="main-nav" aria-label={zh ? '主导航' : 'Main navigation'}>{nav.map(([href, label, short]) => <a key={href} href={pageUrl(href, locale)} aria-label={label} aria-current={path === href || path.startsWith(`${href}/`) ? 'page' : undefined}><span className="nav-label-long">{label}</span><span className="nav-label-short">{short}</span></a>)}</nav>
      <div className="header-actions"><a className="language-link" href={pageUrl(path, zh ? 'en' : 'zh')} lang={zh ? 'en-CA' : 'zh-Hans'}><Icon name="globe" size={17}/>{zh ? 'English' : '中文'}</a><a className="button button-dark button-sm" href="/live">{zh ? '打开实时地图' : 'Open live map'}</a></div>
    </div></header>
    <main id="main">{children}</main>
    <footer className="footer"><div className="container footer-grid">
      <div><a className="brand" href={pageUrl('', locale)}><span className="brand-mark"><Icon name="train" size={23}/></span><span>{BRAND}</span></a><p>{zh ? '帮你看懂票价、找到换乘、从容出发。独立项目，与交通机构无隶属关系。' : 'Understand your fare. Find your connection. An independent project, not affiliated with transit agencies.'}</p></div>
      <div><h2>{zh ? '出行工具' : 'Plan your journey'}</h2><a href={pageUrl('fare-calculator', locale)}>{zh ? '成人票价计算器' : 'Adult fare calculator'}</a><a href={pageUrl('one-fare', locale)}>{zh ? 'One Fare 说明' : 'One Fare explained'}</a><a href="/live">{zh ? '实时地图（需登录）' : 'Live map · sign-in required'}</a></div>
      <div><h2>{zh ? '关于本站' : 'Behind the guide'}</h2><a href={pageUrl('sources', locale)}>{zh ? '来源与更新时间' : 'Sources & freshness'}</a><a href={pageUrl('privacy', locale)}>{zh ? '隐私与项目信息' : 'Privacy & project info'}</a><a href="https://github.com/mrgreedcp-spec/gta-transit-live">{zh ? '开源项目' : 'Open-source project'}</a></div>
    </div><div className="container footer-bottom"><span>© 2026 {BRAND}</span><span>{zh ? '票价规则核实于' : 'Fare rules reviewed'} {REVIEW_DATE} · {zh ? '金额为加元' : 'Prices in CAD'}</span></div></footer>
    {path === '' && <LegacyLaunch/>}
  </>;
}

export function Breadcrumbs({ path, locale }: { path: PagePath; locale: Locale }) {
  const parent = path.includes('/') ? path.split('/')[0] as PagePath : null;
  return <nav className="breadcrumbs container" aria-label={locale === 'zh' ? '面包屑导航' : 'Breadcrumb'}><ol>
    <li><a href={pageUrl('', locale)}>{locale === 'zh' ? '首页' : 'Home'}</a></li>
    {parent && <li><a href={pageUrl(parent, locale)}>{parent === 'operators' ? (locale === 'zh' ? '交通机构' : 'Operators') : (locale === 'zh' ? '路线指南' : 'Journey guides')}</a></li>}
    <li aria-current="page">{path.includes('/') ? tr(pageMeta[path].title, locale).split(' — ')[0].split('：')[0] : path === 'fare-calculator' ? (locale === 'zh' ? '票价计算器' : 'Fare calculator') : path === 'one-fare' ? 'One Fare' : tr(pageMeta[path].title, locale).split(' — ')[0]}</li>
  </ol></nav>;
}
