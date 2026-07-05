/* ================================================================
   chat.js — TalentoHumano IA
   Lógica del widget de chat Thia conectado al webhook de n8n.

   ÍNDICE:
   1.  Configuración
   2.  Gestión del sessionId
   3.  Estado del chat
   4.  Control de la ventana (abrir / cerrar)
   5.  Envío de mensajes al webhook n8n
   6.  Helpers de UI (burbujas, indicador de escritura, scroll)
   7.  Seguridad (sanitización de HTML)
   8.  Eventos del teclado
   ================================================================ */


/* ================================================================
   1. CONFIGURACIÓN
   ----------------------------------------------------------------
   WEBHOOK_URL: URL completa del nodo "Webhook Web" de tu flujo n8n.
   - El path "web-Thia" debe coincidir con el campo "path" del nodo.
   - Si n8n corre en un servidor remoto, reemplaza localhost por
     el dominio o IP pública de tu instancia Docker.
   - Asegúrate de habilitar CORS en n8n si la web corre en un
     dominio o puerto distinto al de n8n.
   ================================================================ */
const WEBHOOK_URL = 'proxy.php';


/* ================================================================
   2. GESTIÓN DEL SESSION ID
   ----------------------------------------------------------------
   Se genera un identificador único por sesión del navegador.
   Este ID se envía en cada mensaje y es usado por el nodo
   "Postgres Chat Memory" de n8n para recuperar el historial
   de conversación del usuario actual.

   Se almacena en sessionStorage (se borra al cerrar la pestaña).
   ================================================================ */

/**
 * Retorna el sessionId de la sesión actual.
 * Si no existe, lo genera y lo persiste en sessionStorage.
 * @returns {string} sessionId único de la sesión
 */
function getSessionId() {
  let sid = sessionStorage.getItem('thia_session_id');

  if (!sid) {
    /* Formato: web_{timestamp}_{string aleatorio de 7 chars} */
    sid = 'web_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);
    sessionStorage.setItem('thia_session_id', sid);
  }

  return sid;
}


/* ================================================================
   3. ESTADO DEL CHAT
   Variables de estado que controlan el comportamiento del widget.
   ================================================================ */
let chatOpen     = false;  // ¿está la ventana de chat visible?
let isLoading    = false;  // ¿hay una petición pendiente al webhook?
let welcomeShown = false;  // ¿ya se mostró el mensaje de bienvenida?


/* ================================================================
   4. CONTROL DE LA VENTANA (abrir / cerrar)
   ================================================================ */

/**
 * Abre la ventana de chat.
 * - Agrega la clase .open al contenedor para disparar la animación CSS.
 * - Muestra el mensaje de bienvenida de Thia la primera vez.
 * - Enfoca el campo de texto para facilitar la escritura.
 */
function openChat() {
  chatOpen = true;

  /* Mostrar la ventana con animación (clase definida en styles.css) */
  document.getElementById('chatWindow').classList.add('open');
  document.getElementById('chatLauncher').setAttribute('aria-expanded', 'true');

  /* Mensaje de bienvenida: solo se muestra una vez por sesión */
  if (!welcomeShown) {
    welcomeShown = true;
    setTimeout(() => {
      appendBotMessage(
        'Chatea con Thia, nuestra Agente de IA. '
      );
    }, 400); /* pequeño retraso para que la animación de apertura termine */
  }

  /* Enfocar el input para que el usuario pueda escribir de inmediato */
  setTimeout(() => {
    const input = document.getElementById('chatInput');
    if (input) input.focus();
  }, 300);
}

/**
 * Cierra la ventana de chat.
 * - Remueve la clase .open para ocultar la ventana con animación.
 */
function closeChat() {
  chatOpen = false;
  document.getElementById('chatWindow').classList.remove('open');
  document.getElementById('chatLauncher').setAttribute('aria-expanded', 'false');
}


/* ================================================================
   5. ENVÍO DE MENSAJES AL WEBHOOK N8N
   ================================================================ */

/**
 * Lee el texto del input, lo muestra en el chat y lo envía al
 * agente Thia mediante una petición POST al webhook de n8n.
 *
 * Flujo:
 *   1. Valida que haya texto y que no haya una petición en curso.
 *   2. Muestra la burbuja del usuario.
 *   3. Muestra el indicador de escritura.
 *   4. Hace POST al webhook con { message, sessionId }.
 *   5. Recibe la respuesta y la muestra como burbuja del agente.
 *   6. En caso de error, muestra un mensaje de fallback amigable.
 */
async function sendMessage() {
  /* Evitar envíos dobles mientras se espera respuesta */
  if (isLoading) return;

  const input = document.getElementById('chatInput');
  const text  = input.value.trim();

  /* No enviar si el campo está vacío */
  if (!text) return;

  /* 1. Mostrar mensaje del usuario en la UI y limpiar el input */
  appendUserMessage(text);
  input.value = '';

  /* 2. Mostrar indicador de escritura ("Thia está escribiendo...") */
  const typingEl = showTyping();

  /* 3. Bloquear envíos adicionales mientras se procesa */
  isLoading = true;
  disableSend(true);

  try {
    /* ----------------------------------------------------------
       PETICIÓN AL WEBHOOK N8N
       -------------------------------------------------------
       El nodo "Webhook Web" espera un POST con Content-Type JSON.
       Campos enviados:
         - message:   texto del usuario (requerido por el AI Agent)
         - sessionId: identificador de sesión para la memoria Postgres

       La respuesta viene del nodo "Responder al Chat Web":
         { "response": "<texto del agente>" }
       ---------------------------------------------------------- */
const response = await fetch(WEBHOOK_URL, {
      method:  'POST',
      headers: { 
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        message:   text,
        sessionId: getSessionId()
      })
    });

    /* Remover indicador de escritura antes de mostrar la respuesta */
    typingEl.remove();

    /* Verificar que el servidor respondió correctamente */
    if (!response.ok) {
      throw new Error('HTTP ' + response.status + ' – ' + response.statusText);
    }

    const data = await response.json();

    /* El nodo "Responder al Chat Web" devuelve { response: "..." }.
       También aceptamos { output: "..." } como campo alternativo
       en caso de cambios en la configuración del nodo.             */
    const agentReply =
      data.response ||
      data.output   ||
      'Lo siento, no pude procesar tu consulta en este momento. Por favor intenta de nuevo.';

    /* 4. Mostrar la respuesta del agente */
    appendBotMessage(agentReply);

  } catch (err) {
    /* Error de red o timeout: mostrar mensaje de fallback */
    typingEl.remove();
    appendBotMessage(
      'Parece que hay un problema de conexión en este momento. ' +
      'Por favor intenta de nuevo o escríbenos directamente por WhatsApp.'
    );
    console.error('[Thia Chat] Error al contactar el webhook n8n:', err);
  }

  /* 5. Restaurar estado de envío */
  isLoading = false;
  disableSend(false);
  input.focus();
}


/* ================================================================
   6. HELPERS DE UI
   Funciones auxiliares para manipular el DOM del chat.
   ================================================================ */

/**
 * Añade una burbuja de mensaje del USUARIO al área de chat.
 * @param {string} text - Texto a mostrar (se sanitiza antes de insertar)
 */
function appendUserMessage(text) {
  const messagesEl = document.getElementById('chatMessages');
  const now = getTimeString();

  const msgEl = document.createElement('div');
  msgEl.className = 'msg user';
  msgEl.setAttribute('role', 'listitem');
  msgEl.innerHTML =
    '<div class="msg-bubble">' + escapeHtml(text) + '</div>' +
    '<span class="msg-time" aria-label="Enviado a las ' + now + '">' + now + '</span>';

  messagesEl.appendChild(msgEl);
  scrollToBottom();
}

/**
 * Añade una burbuja de mensaje del AGENTE (Thia) al área de chat.
 * Convierte saltos de línea (\n) en <br> para respetar el formato
 * de las respuestas multi-línea que puede generar el AI Agent.
 * @param {string} text - Texto a mostrar (se sanitiza antes de insertar)
 */
function appendBotMessage(text) {
  const messagesEl = document.getElementById('chatMessages');
  const now = getTimeString();

  /* Sanitizar primero y luego convertir \n a <br> */
  const formatted = escapeHtml(text).replace(/\n/g, '<br>');

  const msgEl = document.createElement('div');
  msgEl.className = 'msg bot';
  msgEl.setAttribute('role', 'listitem');
  msgEl.innerHTML =
    '<div class="msg-bubble">' + formatted + '</div>' +
    '<span class="msg-time" aria-label="Recibido a las ' + now + '">' + now + '</span>';

  messagesEl.appendChild(msgEl);
  scrollToBottom();
}

/**
 * Muestra el indicador animado "Thia está escribiendo...".
 * Retorna el elemento DOM para que pueda ser eliminado luego.
 * @returns {HTMLElement} el elemento del indicador de escritura
 */
function showTyping() {
  const messagesEl = document.getElementById('chatMessages');

  const typingEl = document.createElement('div');
  typingEl.className = 'msg bot';
  typingEl.setAttribute('aria-label', 'Thia está escribiendo');
  typingEl.innerHTML =
    '<div class="typing-indicator">' +
      '<div class="typing-dot"></div>' +
      '<div class="typing-dot"></div>' +
      '<div class="typing-dot"></div>' +
    '</div>';

  messagesEl.appendChild(typingEl);
  scrollToBottom();
  return typingEl;
}

/**
 * Desplaza el área de mensajes hasta el último mensaje.
 * Se llama después de cada nueva burbuja añadida.
 */
function scrollToBottom() {
  const el = document.getElementById('chatMessages');
  if (el) el.scrollTop = el.scrollHeight;
}

/**
 * Habilita o deshabilita el botón de envío.
 * Se usa para bloquear envíos mientras se espera la respuesta de n8n.
 * @param {boolean} disabled - true para deshabilitar, false para habilitar
 */
function disableSend(disabled) {
  const btn = document.getElementById('sendBtn');
  if (!btn) return;
  btn.disabled    = disabled;
  btn.style.opacity = disabled ? '.5' : '1';
}

/**
 * Retorna la hora actual formateada como HH:MM.
 * Se usa para mostrar la marca de tiempo en cada mensaje.
 * @returns {string} hora actual en formato HH:MM
 */
function getTimeString() {
  return new Date().toLocaleTimeString('es-CO', {
    hour:   '2-digit',
    minute: '2-digit'
  });
}


/* ================================================================
   7. SEGURIDAD — SANITIZACIÓN DE HTML
   ----------------------------------------------------------------
   Previene ataques XSS escapando caracteres especiales HTML
   antes de insertar cualquier texto en el DOM.
   ================================================================ */

/**
 * Escapa caracteres especiales HTML para prevenir XSS.
 * @param {string} str - Texto a sanitizar
 * @returns {string} Texto seguro para insertar como innerHTML
 */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#039;');
}


/* ================================================================
   8. EVENTOS DEL TECLADO
   ================================================================ */

/* Esperar a que el DOM esté listo antes de registrar eventos */
document.addEventListener('DOMContentLoaded', function () {

  /* Enviar mensaje con la tecla Enter (sin Shift, para no romper
     saltos de línea si el usuario los usa deliberadamente)       */
  const chatInput = document.getElementById('chatInput');
  if (chatInput) {
    chatInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault(); /* evitar salto de línea en el input */
        sendMessage();
      }
    });
  }

  /* Cerrar el chat con la tecla Escape cuando esté abierto */
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && chatOpen) {
      closeChat();
    }
  });

});
