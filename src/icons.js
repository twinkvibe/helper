import {
  Bold, Italic, Strikethrough, List, ListChecks, Link, Code, SquareCode,
  Quote, Image, Heading1, Heading2, Heading3, ImagePlus, Search, Plus,
  RefreshCw, CalendarDays, MoreHorizontal, Download, Upload, Trash2,
  FileText, CheckSquare, Settings, Users, LogOut, Newspaper, History,
  Menu, X, RotateCcw, RotateCw, createElement,
} from 'lucide';

const icons = {
  bold: Bold,
  italic: Italic,
  strike: Strikethrough,
  list: List,
  checklist: ListChecks,
  link: Link,
  code: Code,
  codeBlock: SquareCode,
  quote: Quote,
  image: Image,
  imagePlus: ImagePlus,
  h1: Heading1,
  h2: Heading2,
  h3: Heading3,
  search: Search,
  plus: Plus,
  refresh: RefreshCw,
  today: CalendarDays,
  more: MoreHorizontal,
  download: Download,
  upload: Upload,
  trash: Trash2,
  note: FileText,
  articles: Newspaper,
  adminArticles: Newspaper,
  logs: History,
  tasks: CheckSquare,
  settings: Settings,
  users: Users,
  logout: LogOut,
  menu: Menu,
  close: X,
  rotateLeft: RotateCcw,
  rotateRight: RotateCw,
  reset: RefreshCw,
};

export function icon(name, label = '') {
  const node = createElement(icons[name] || FileText, {
    class: 'ui-icon',
    'aria-hidden': 'true',
  });
  if (label) node.setAttribute('data-label', label);
  return node;
}

export function iconButton(name, label, onClick, className = 'icon-button') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.title = label;
  button.setAttribute('aria-label', label);
  button.append(icon(name));
  button.onclick = onClick;
  return button;
}
