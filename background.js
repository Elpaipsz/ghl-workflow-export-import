// GHL es whitelabel: cada agencia abre la app en su propio dominio, así que no
// podemos declarar de antemano en qué sitio inyectar el script. En vez de pedir
// acceso a "todos los sitios" (<all_urls>), esperamos a que el usuario haga
// clic en el ícono de la extensión: eso concede acceso temporal solo a esa
// pestaña (permiso "activeTab"), sin ninguna advertencia de acceso amplio.
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;

  try {
    // inject.js necesita correr en el mundo "MAIN" (el de la página) para ver
    // las llamadas fetch/XHR que la propia app de GHL ya hace.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      world: "MAIN",
      files: ["inject.js"],
    });

    // content.js corre en el mundo aislado de la extensión: dibuja el panel y
    // hace las llamadas de exportar/importar.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: ["content.js"],
    });
  } catch (e) {
    console.error("[GHL Workflow Tool] No se pudo activar en esta pestaña:", e);
  }
});
