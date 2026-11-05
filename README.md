# VIÁTIKO API — Control de Viáticos y Gastos de Transporte

Plataforma SaaS para la captura, digitalización mediante OCR con Inteligencia Artificial, control de anticipos y liquidación contable de gastos de ruta para flotas de transporte de carga.

---

## Stack Tecnológico

* **Entorno de ejecución:** Node.js (ES Modules)
* **Framework Web:** Express.js
* **Base de Datos:** PostgreSQL (alojada en Neon.tech)
* **ORM:** Prisma
* **Motor OCR / IA:** Google Gemini API
* **Seguridad & Hashing:** bcryptjs, helmet, cors
* **Frontend integrado:** HTML5 / JavaScript Vanilla / Tailwind CSS (móvil y responsive)

---

## Arquitectura de Seguridad y Datos

* **Segregación Multi-Empresa (Multi-Tenant):** Todas las entidades (`Conductor`, `Gasto`, `Puc`, `ViajeLiquidado`) están estrictamente asociadas a una `Empresa` vía `empresaId`, garantizando el aislamiento de datos entre clientes.
* **Cifrado de Credenciales:** Contraseñas protegidas mediante algoritmos de hash unidireccional con salt rounds usando `bcryptjs`.
* **Roles del Sistema:**
  * `conductor`: Registro de gastos manuales/comprobantes y cierre formal de liquidación de su viaje.
  * `admin`: Asignación y recarga de anticipos, consulta de historial global y exportación de planos contables.

---

## Variables de Entorno (.env)

Crea un archivo `.env` en la raíz del proyecto con la siguiente estructura:

```env
PORT=3000
DATABASE_URL="postgresql://neondb_owner:PASSWORD@ep-xxxx.us-east-2.aws.neon.tech/neondb?sslmode=require"
GEMINI_API_KEY="AIzaSy..."
NODE_ENV="production"