const $ = (id) => document.getElementById(id);
let mode = "login";
let busy = false;

function setMode(next) {
  mode = next;
  const registering = mode === "register";
  $("form-title").textContent = registering ? "Claim your name." : "Get back in.";
  $("form-subtitle").textContent = registering ? "The city is wide open." : "Your crew's been waiting.";
  $("username-wrap").classList.toggle("hidden", !registering);
  $("email-wrap").classList.toggle("hidden", !registering);
  $("identity-wrap").classList.toggle("hidden", registering);
  $("identity").required = !registering;
  $("username").required = registering;
  $("email").required = registering;
  $("password").autocomplete = registering ? "new-password" : "current-password";
  $("submit-label").textContent = registering ? "CREATE YOUR ACCOUNT" : "ENTER THE CITY";
  document.querySelectorAll(".mode-tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.mode === mode));
  $("form-error").textContent = "";
}

document.querySelectorAll(".mode-tab").forEach((tab) => tab.addEventListener("click", () => setMode(tab.dataset.mode)));

$("auth-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;
  busy = true;
  $("submit-button").disabled = true;
  $("form-error").textContent = "";
  try {
    const payload = mode === "register"
      ? { username: $("username").value, email: $("email").value, password: $("password").value }
      : { identity: $("identity").value, password: $("password").value };
    const response = await fetch(`/api/${mode}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "Authentication failed");
    window.location.assign("/play");
  } catch (error) {
    $("form-error").textContent = error.message;
  } finally {
    busy = false;
    $("submit-button").disabled = false;
  }
});

fetch("/api/me").then((response) => { if (response.ok) window.location.replace("/play"); }).catch(() => {});
