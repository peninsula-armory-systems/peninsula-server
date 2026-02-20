const loginSection = document.getElementById("login-section");
const usersSection = document.getElementById("users-section");
const loginForm = document.getElementById("login-form");
const loginError = document.getElementById("login-error");
const loginInfo = document.getElementById("login-info");
const apiUrlInput = document.getElementById("api-url");
const rememberUrlCheckbox = document.getElementById("remember-url");
const logoutBtn = document.getElementById("logout-btn");
const usersTable = document.getElementById("users-table");
const createForm = document.getElementById("create-form");
const createError = document.getElementById("create-error");

let apiUrl = "";
let accessToken = "";

// Charger l'URL sauvegardée au démarrage
function loadSavedApiUrl() {
  const savedUrl = localStorage.getItem("peninsula_api_url");
  if (savedUrl) {
    apiUrlInput.value = savedUrl;
    rememberUrlCheckbox.checked = true;
  }
}

function showLogin() {
  loginSection.classList.remove("hidden");
  usersSection.classList.add("hidden");
  loginError.textContent = "";
  createError.textContent = "";
}

function showUsers() {
  loginSection.classList.add("hidden");
  usersSection.classList.remove("hidden");
}

async function apiRequest(path, options = {}) {
  const response = await fetch(`${apiUrl}${path}`, {
    headers: {
      "Content-Type": "application/json",
      Authorization: accessToken ? `Bearer ${accessToken}` : ""
    },
    ...options
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = data?.error || "Erreur API";
    throw new Error(error);
  }
  return data;
}

async function loadUsers() {
  const data = await apiRequest("/v1/admin/users/list");
  usersTable.innerHTML = "";
  data.users.forEach((user) => {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${user.id}</td>
      <td>${user.username}</td>
      <td>${user.role}</td>
      <td>${new Date(user.created_at).toLocaleString()}</td>
      <td>
        <button class="secondary" data-action="reset" data-id="${user.id}">Reset MDP</button>
        <button class="danger" data-action="delete" data-id="${user.id}">Supprimer</button>
      </td>
    `;
    usersTable.appendChild(row);
  });
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginError.textContent = "";
  apiUrl = apiUrlInput.value.trim();
  const username = document.getElementById("login-username").value.trim();
  const password = document.getElementById("login-password").value;

  // Sauvegarder l'URL si la checkbox est cochée
  if (rememberUrlCheckbox.checked) {
    localStorage.setItem("peninsula_api_url", apiUrl);
  } else {
    localStorage.removeItem("peninsula_api_url");
  }

  try {
    const data = await apiRequest("/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password })
    });
    accessToken = data.accessToken;
    loginInfo.textContent = `Connecté en tant que ${username}`;
    showUsers();
    await loadUsers();
  } catch (error) {
    loginError.textContent = error.message;
  }
});

logoutBtn.addEventListener("click", () => {
  accessToken = "";
  showLogin();
});

createForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  createError.textContent = "";

  const username = document.getElementById("create-username").value.trim();
  const password = document.getElementById("create-password").value;
  const role = document.getElementById("create-role").value;

  try {
    await apiRequest("/v1/admin/users/create", {
      method: "POST",
      body: JSON.stringify({ username, password, role })
    });
    createForm.reset();
    await loadUsers();
  } catch (error) {
    createError.textContent = error.message;
  }
});

usersTable.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) return;

  const action = target.dataset.action;
  const id = Number(target.dataset.id);
  if (!action || !id) return;

  try {
    if (action === "delete") {
      await apiRequest("/v1/admin/users/delete", {
        method: "POST",
        body: JSON.stringify({ id })
      });
    }
    if (action === "reset") {
      const newPassword = prompt("Nouveau mot de passe ?");
      if (!newPassword) return;
      await apiRequest("/v1/admin/users/update", {
        method: "POST",
        body: JSON.stringify({ id, password: newPassword })
      });
    }
    await loadUsers();
  } catch (error) {
    alert(error.message);
  }
});

// Charger l'URL sauvegardée au démarrage
loadSavedApiUrl();
showLogin();
