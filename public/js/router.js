const routes = new Map();

export function registerRoute(path, render) {
  routes.set(path, render);
}

export function navigate(path) {
  window.location.hash = path;
}

export function currentPath() {
  const hash = window.location.hash.replace(/^#/, '');
  return hash || '/dashboard';
}

export function startRouter(onRouteChange) {
  const handle = () => onRouteChange(currentPath());
  window.addEventListener('hashchange', handle);
  handle();
}

export function getRoute(path) {
  return routes.get(path);
}

export function allRoutes() {
  return Array.from(routes.keys());
}
