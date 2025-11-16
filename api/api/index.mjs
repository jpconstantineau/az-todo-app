// api/index.mjs
// App shell
import "./app/index.mjs";

// Lists
import "./lists/all.mjs";
import "./lists/create.mjs";
import "./lists/editDefaults.mjs";
import "./lists/updateDefaults.mjs";
import "./lists/resetDefaults.mjs";
import "./lists/quickAddForm.mjs";

// Items
import "./items/byList.mjs";
import "./items/create.mjs";
//import "./items/toggleComplete.mjs";
import "./items/filterByStatus.mjs";

// Settings
import "./settings/ensure.mjs";
import "./settings/edit.mjs";
import "./settings/update.mjs";
import "./settings/reset.mjs";

// Optional: simple health check for debugging
import "./misc/health.mjs";