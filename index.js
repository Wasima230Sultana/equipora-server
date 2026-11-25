import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import { MongoClient, ObjectId } from 'mongodb';
import Stripe from 'stripe'
const app = express();
const port = process.env.PORT || 5000;

const stripe = new Stripe (process.env.STRIPE_SECRET_KEY)
// middleware
app.use(express.json());
app.use(cors());

const client = new MongoClient(`mongodb://${process.env.DB_USER}:${process.env.DB_PASSWORD}@ac-bl6n1e4-shard-00-00.6tutdbk.mongodb.net:27017,ac-bl6n1e4-shard-00-01.6tutdbk.mongodb.net:27017,ac-bl6n1e4-shard-00-02.6tutdbk.mongodb.net:27017/?ssl=true&replicaSet=atlas-36159o-shard-0&authSource=admin`);

export async function connectToMongoDB() {
    try {
        await client.connect();
        console.log("You successfully connected to MongoDB!");
        return client;
    } catch (err) {
        console.dir(err);
    }
}

const connectedClient = await connectToMongoDB();
const database = connectedClient.db("equipora");
const users = database.collection("user");
const equipmentCollection = database.collection("equipment");
const rentalsCollection = database.collection("rentals");
const favoritesCollection = database.collection("favorites");

// Status values accepted from the payment flow and the admin dashboard.
const PAYMENT_STATUSES = ["Paid", "Pending", "Failed", "Refunded"];
const BOOKING_STATUSES = ["Pending", "Confirmed", "Active", "Completed", "Cancelled"];

// Admin-rejected listings are hidden from customer-facing endpoints.
// Owner and admin management views keep showing them so they can be fixed/reviewed.
const HIDDEN_EQUIPMENT_STATUS = "Rejected";
const visibleEquipmentQuery = (query = {}) => ({
    ...query,
    status: { $ne: HIDDEN_EQUIPMENT_STATUS },
});

app.get('/', (req, res) => {
    res.send('equipora is looping')
})

app.get('/user', async (req, res) => {
    const cursor = users.find({});
    const result = await cursor.toArray();
    res.send(result);
})

// ---------------------------------------------------------------------------
// Recent uploads (shared by every dashboard role)
// Returns the most recently added equipment across all owners, newest first.
// ---------------------------------------------------------------------------
app.get('/equipment/recent', async (req, res) => {
    const requested = Number(req.query.limit);
    const limit = Number.isFinite(requested) && requested > 0
        ? Math.min(Math.floor(requested), 20)
        : 4;

    const docs = await equipmentCollection
        .find(visibleEquipmentQuery())
        .sort({ createdAt: -1 })
        .limit(limit)
        .toArray();

    const uploads = (await attachOwners(docs)).map((item) => ({
        id: item.id,
        name: item.name,
        category: item.category,
        location: item.location,
        status: item.status,
        image: item.image,
        ownerName: item.owner?.name ?? "",
        createdAt: item.createdAt ?? null,
    }));

    console.log("[Backend] recent uploads ->", uploads.length, "item(s)");
    res.json({ uploads });
})

// ---------------------------------------------------------------------------
// Owner equipment API (backend only - no UI code lives here)
// The client sends the owner id in the URL; we verify it against the user
// collection before touching any equipment or rental data.
// ---------------------------------------------------------------------------

const editableFields = [
    "name", "description", "category", "location", "rentalPrice",
    "rentalType", "availableQuantity", "condition", "brand", "model",
    "image", "terms"
];

function toEquipment(doc, owner) {
    const { _id, ...fields } = doc;
    return { ...fields, id: _id.toHexString(), owner };
}

function toRental(doc) {
    const { _id, ...fields } = doc;
    return { ...fields, id: _id.toHexString() };
}

/** Add owner info to equipment documents for the shared browse/details feeds. */
async function attachOwners(docs) {
    const ownerIds = [...new Set(
        docs.map((doc) => doc.ownerId?.toString())
            .filter((id) => id && ObjectId.isValid(id))
    )];
    const ownerDocs = ownerIds.length
        ? await users.find({ _id: { $in: ownerIds.map((id) => new ObjectId(id)) } }).toArray()
        : [];
    const owners = new Map(ownerDocs.map((user) => [
        user._id.toHexString(),
        {
            id: user._id.toHexString(),
            name: user.name ?? "",
            email: user.email ?? "",
            phone: user.phone ?? "",
            company: user.company ?? "",
        },
    ]));

    return docs.map((doc) => toEquipment(doc, owners.get(doc.ownerId?.toString()) ?? {
        id: doc.ownerId?.toString() ?? "",
        name: "", email: "", phone: "", company: "",
    }));
}

function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseBound(value) {
    if (value === undefined || value === null || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
}

const browseSorts = {
    price_asc: { rentalPrice: 1, createdAt: -1 },
    price_desc: { rentalPrice: -1, createdAt: -1 },
    recent: { createdAt: -1 },
};

// ---------------------------------------------------------------------------
// Public browse API. Admin-rejected listings are excluded; all other search,
// filters and sorting are applied by MongoDB here, not in the browser.
// ---------------------------------------------------------------------------
app.get('/equipment', async (req, res) => {
    const query = visibleEquipmentQuery();

    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    if (search) {
        const pattern = new RegExp(escapeRegex(search), "i");
        query.$or = [{ name: pattern }, { location: pattern }];
    }

    if (typeof req.query.category === "string" && req.query.category) {
        query.category = req.query.category;
    }
    if (["Daily", "Weekly", "Monthly"].includes(req.query.rentalType)) {
        query.rentalType = req.query.rentalType;
    }

    const min = parseBound(req.query.minPrice);
    const max = parseBound(req.query.maxPrice);
    if (min !== null || max !== null) {
        query.rentalPrice = {};
        if (min !== null) query.rentalPrice.$gte = min;
        if (max !== null) query.rentalPrice.$lte = max;
    }

    if (req.query.availability === "available") query.availableQuantity = { $gt: 0 };
    if (req.query.availability === "unavailable") query.availableQuantity = { $lte: 0 };

    const sort = browseSorts[req.query.sort] ?? browseSorts.recent;
    const docs = await equipmentCollection.find(query).sort(sort).toArray();
    console.log("[Backend] browse equipment ->", docs.length, "item(s)");
    res.json({ equipment: await attachOwners(docs) });
})

// Featured approved listings for the homepage. The limit is applied in MongoDB.
app.get('/equipment/featured', async (req, res) => {
    const requested = Number(req.query.limit);
    const limit = Number.isFinite(requested) && requested > 0
        ? Math.min(Math.floor(requested), 12)
        : 6;

    const docs = await equipmentCollection
        .find({ status: "Approved" })
        .sort({ createdAt: -1 })
        .limit(limit)
        .toArray();

    const equipment = await attachOwners(docs);
    console.log("[Backend] featured equipment ->", equipment.length, "item(s)");
    res.json({ equipment });
})

// Full details of one listing. Access is restricted in the UI to signed-in users.
app.get('/equipment/:id', async (req, res) => {
    if (!ObjectId.isValid(req.params.id)) {
        return res.status(400).json({ error: "Invalid equipment id." });
    }
    const doc = await equipmentCollection.findOne(
        visibleEquipmentQuery({ _id: new ObjectId(req.params.id) })
    );
    if (!doc) return res.status(404).json({ error: "Equipment not found." });

    const [equipment] = await attachOwners([doc]);
    res.json({ equipment });
})

function readInput(body) {
    if (!body?.name?.trim() || !body.category || Number(body.rentalPrice) <= 0) {
        return null;
    }
    return {
        name: body.name.trim(),
        description: typeof body.description === "string" ? body.description : "",
        category: body.category,
        location: typeof body.location === "string" ? body.location : "",
        rentalPrice: Number(body.rentalPrice),
        rentalType: body.rentalType || "Daily",
        availableQuantity: Number(body.availableQuantity ?? 1),
        condition: body.condition || "Good",
        brand: typeof body.brand === "string" ? body.brand : "",
        model: typeof body.model === "string" ? body.model : "",
        image: typeof body.image === "string" ? body.image : "",
        terms: typeof body.terms === "string" ? body.terms : "",
    };
}

function readPatch(body) {
    const patch = {};
    for (const field of editableFields) {
        if (body?.[field] !== undefined) patch[field] = body[field];
    }
    return patch;
}

async function checkOwnerId(req, res, next) {
    const ownerId = req.params.ownerId;
    console.log("[Backend] checking owner id:", ownerId);

    if (!ObjectId.isValid(ownerId)) {
        console.warn("[Backend] invalid owner id");
        return res.status(400).json({ error: "Invalid owner id." });
    }

    const user = await users.findOne({ _id: new ObjectId(ownerId), role: "owner" });
    if (!user) {
        console.warn("[Backend] owner not found");
        return res.status(403).json({ error: "Owner not found." });
    }

    req.owner = {
        id: ownerId,
        name: user.name ?? "",
        email: user.email ?? "",
        phone: user.phone ?? "",
        company: user.company ?? "",
    };
    console.log("[Backend] owner verified:", user.email);
    next();
}

async function findOwnedEquipment(req, res) {
    const id = req.params.id;
    if (!ObjectId.isValid(id)) {
        console.warn("[Backend] invalid equipment id:", id);
        res.status(400).json({ error: "Invalid equipment id." });
        return null;
    }
    const doc = await equipmentCollection.findOne({
        _id: new ObjectId(id),
        ownerId: req.owner.id,
    });
    if (!doc) {
        console.warn("[Backend] equipment not found:", id);
        res.status(404).json({ error: "Equipment not found." });
        return null;
    }
    console.log("[Backend] equipment lookup:", id, "found");
    return doc;
}

// Owner info for the Add Equipment form.
app.get('/owner/:ownerId', checkOwnerId, (req, res) => {
    console.log("[Backend] GET owner info");
    res.json({ owner: req.owner });
});

// All equipment belonging to this owner.
app.get('/owner/:ownerId/equipment', checkOwnerId, async (req, res) => {
    console.log("[Backend] GET equipment list");
    const docs = await equipmentCollection
        .find({ ownerId: req.owner.id })
        .sort({ createdAt: -1 })
        .toArray();
    console.log("[Backend] equipment list ->", docs.length, "item(s)");
    res.json({
        owner: req.owner,
        equipment: docs.map((doc) => toEquipment(doc, req.owner)),
    });
});

// Add a listing - new listings always start as Pending.
app.post('/owner/:ownerId/equipment', checkOwnerId, async (req, res) => {
    console.log("[Backend] POST equipment");
    const input = readInput(req.body);
    if (!input) {
        console.warn("[Backend] POST validation failed");
        return res.status(400).json({ error: "Name, category and a valid rental price are required." });
    }
    const doc = {
        ...input,
        ownerId: req.owner.id,
        status: "Pending",
        createdAt: new Date().toISOString(),
    };
    const result = await equipmentCollection.insertOne(doc);
    console.log("[Backend] equipment created:", result.insertedId.toHexString());
    res.status(201).json({ equipment: toEquipment({ ...doc, _id: result.insertedId }, req.owner) });
});

// Full details of one listing.
app.get('/owner/:ownerId/equipment/:id', checkOwnerId, async (req, res) => {
    console.log("[Backend] GET equipment details");
    const doc = await findOwnedEquipment(req, res);
    if (!doc) return;
    res.json({ equipment: toEquipment(doc, req.owner) });
});

// Update a listing (status is intentionally not editable here).
app.patch('/owner/:ownerId/equipment/:id', checkOwnerId, async (req, res) => {
    console.log("[Backend] PATCH equipment");
    const existing = await findOwnedEquipment(req, res);
    if (!existing) return;

    const patch = readPatch(req.body);
    if (Object.keys(patch).length === 0) {
        console.warn("[Backend] PATCH has no editable fields");
        return res.status(400).json({ error: "No editable fields were provided." });
    }
    await equipmentCollection.updateOne(
        { _id: existing._id, ownerId: req.owner.id },
        { $set: patch }
    );
    console.log("[Backend] equipment updated:", req.params.id);
    const updated = await equipmentCollection.findOne({ _id: existing._id });
    res.json({ equipment: toEquipment(updated, req.owner) });
});

// Delete a listing.
app.delete('/owner/:ownerId/equipment/:id', checkOwnerId, async (req, res) => {
    console.log("[Backend] DELETE equipment");
    const existing = await findOwnedEquipment(req, res);
    if (!existing) return;
    await equipmentCollection.deleteOne({ _id: existing._id, ownerId: req.owner.id });
    console.log("[Backend] equipment deleted:", req.params.id);
    res.json({ success: true });
});

// Bookings against this owner's equipment.
app.get('/owner/:ownerId/rentals', checkOwnerId, async (req, res) => {
    console.log("[Backend] GET owner rentals");
    const owned = await equipmentCollection
        .find({ ownerId: req.owner.id }, { projection: { _id: 1 } })
        .toArray();
    const ownedIds = owned.map((item) => item._id.toHexString());

    if (ownedIds.length === 0) {
        console.log("[Backend] no equipment -> no rentals");
        return res.json({ rentals: [] });
    }

    const docs = await rentalsCollection
        .find({ equipmentId: { $in: ownedIds } })
        .toArray();
    console.log("[Backend] rentals ->", docs.length, "booking(s)");
    res.json({ rentals: docs.map(toRental) });
});

// ---------------------------------------------------------------------------
// Customer rentals & favorites (backend only)
// ---------------------------------------------------------------------------

async function checkCustomerId(req, res, next) {
    const customerId = req.params.customerId;
    console.log("[Backend] checking customer id:", customerId);

    if (!ObjectId.isValid(customerId)) {
        return res.status(400).json({ error: "Invalid customer id." });
    }
    // Any signed-in user may save equipment and make a booking from browse.
    const user = await users.findOne({ _id: new ObjectId(customerId) });
    if (!user) {
        console.warn("[Backend] user not found");
        return res.status(403).json({ error: "User not found." });
    }
    req.customerId = customerId;
    console.log("[Backend] user verified:", user.email);
    next();
}

function toCustomerRental(doc) {
    const { _id, ...fields } = doc;
    return { ...fields, id: _id.toHexString() };
}

// All rental bookings made by this customer.
app.get('/customer/:customerId/rentals', checkCustomerId, async (req, res) => {
    console.log("[Backend] GET customer rentals");
    const docs = await rentalsCollection
        .find({ customerId: req.customerId })
        .sort({ bookingDate: -1 })
        .toArray();
    console.log("[Backend] customer rentals ->", docs.length, "booking(s)");
    res.json({ rentals: docs.map(toCustomerRental) });
});

// Create a booking from the equipment details page.
app.post('/customer/:customerId/rentals', checkCustomerId, async (req, res) => {
    const { equipmentId, rentalStartDate, rentalEndDate, requiredQuantity } = req.body ?? {};

    if (!ObjectId.isValid(equipmentId) || !rentalStartDate || !rentalEndDate) {
        return res.status(400).json({ error: "Select equipment and both rental dates." });
    }

    const start = new Date(rentalStartDate);
    const end = new Date(rentalEndDate);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) {
        return res.status(400).json({ error: "The end date must be on or after the start date." });
    }

    const equipment = await equipmentCollection.findOne({ _id: new ObjectId(equipmentId) });
    if (!equipment || equipment.status === HIDDEN_EQUIPMENT_STATUS) {
        return res.status(404).json({ error: "Equipment not found." });
    }

    const quantity = Math.max(1, Math.floor(Number(requiredQuantity) || 1));
    if (quantity > Number(equipment.availableQuantity ?? 0)) {
        return res.status(400).json({ error: "The requested quantity is not available." });
    }

    const days = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / 86_400_000) + 1);
    const doc = {
        customerId: req.customerId,
        equipmentId: String(equipmentId),
        equipmentName: equipment.name ?? "",
        equipmentImage: equipment.image ?? "",
        rentalStartDate: start.toISOString(),
        rentalEndDate: end.toISOString(),
        bookingDate: new Date().toISOString(),
        requiredQuantity: quantity,
        totalAmount: days * Number(equipment.rentalPrice) * quantity,
        paymentStatus: "Pending",
        bookingStatus: "Pending",
    };
    const result = await rentalsCollection.insertOne(doc);
    console.log("[Backend] booking created:", result.insertedId.toHexString());
    res.status(201).json({ rental: toCustomerRental({ ...doc, _id: result.insertedId }) });
});

// ---------------------------------------------------------------------------
// Stripe payment confirmation (server-to-server calls from the Next.js app)
// ---------------------------------------------------------------------------

// Only the Next.js route handlers know this shared secret. A browser cannot
// call the payment update endpoint without it.
function checkInternalRequest(req, res, next) {
    const secret = process.env.INTERNAL_API_SECRET;
    if (!secret || req.get('x-internal-secret') !== secret) {
        console.warn("[Backend] rejected payment update: missing/invalid internal secret");
        return res.status(401).json({ error: "Unauthorized payment update." });
    }
    next();
}

function toCustomerContact(user) {
    return {
        name: user?.name ?? "",
        email: user?.email ?? "",
        phone: user?.phone ?? "",
        address: user?.address ?? "",
    };
}

// One rental plus the customer details shown on the payment success page.
app.get('/customer/:customerId/rentals/:rentalId', checkCustomerId, async (req, res) => {
    if (!ObjectId.isValid(req.params.rentalId)) {
        return res.status(400).json({ error: "Invalid rental id." });
    }
    const doc = await rentalsCollection.findOne({
        _id: new ObjectId(req.params.rentalId),
        customerId: req.customerId,
    });
    if (!doc) return res.status(404).json({ error: "Rental not found." });

    const user = await users.findOne(
        { _id: new ObjectId(req.customerId) },
        { projection: { name: 1, email: 1, phone: 1, address: 1 } }
    );
    console.log("[Backend] GET customer rental:", req.params.rentalId);
    res.json({ rental: { ...toCustomerRental(doc), customer: toCustomerContact(user) } });
});

// Mark a rental as paid (or cancelled) after Stripe confirms the payment.
// Safe to call more than once: every field is set to the same final value.
app.patch('/customer/:customerId/rentals/:rentalId/payment', checkCustomerId, checkInternalRequest, async (req, res) => {
    const body = req.body ?? {};
    const patch = {};

    if (PAYMENT_STATUSES.includes(body.paymentStatus)) patch.paymentStatus = body.paymentStatus;
    if (BOOKING_STATUSES.includes(body.bookingStatus)) patch.bookingStatus = body.bookingStatus;
    if (typeof body.paymentIntentId === "string") patch.stripePaymentIntentId = body.paymentIntentId;
    if (typeof body.currency === "string") patch.currency = body.currency;
    if (typeof body.paidAmount === "number" && Number.isFinite(body.paidAmount)) patch.paidAmount = body.paidAmount;

    if (!ObjectId.isValid(req.params.rentalId) || Object.keys(patch).length === 0) {
        return res.status(400).json({ error: "No valid payment fields were provided." });
    }

    const result = await rentalsCollection.updateOne(
        { _id: new ObjectId(req.params.rentalId), customerId: req.customerId },
        { $set: patch }
    );
    if (!result.matchedCount) return res.status(404).json({ error: "Rental not found." });

    const updated = await rentalsCollection.findOne({ _id: new ObjectId(req.params.rentalId) });
    console.log("[Backend] rental payment updated:", req.params.rentalId, patch.paymentStatus ?? "");
    res.json({ rental: toCustomerRental(updated) });
});

// Favorite equipment of this customer, joined with the equipment records.
app.get('/customer/:customerId/favorites', checkCustomerId, async (req, res) => {
    console.log("[Backend] GET customer favorites");
    const favorites = await favoritesCollection.find({ customerId: req.customerId }).toArray();
    const ids = favorites
        .map((favorite) => ObjectId.isValid(favorite.equipmentId) ? new ObjectId(favorite.equipmentId) : null)
        .filter(Boolean);

    if (ids.length === 0) {
        console.log("[Backend] no favorites yet");
        return res.json({ favorites: [] });
    }
    const docs = await equipmentCollection
        .find(visibleEquipmentQuery({ _id: { $in: ids } }))
        .toArray();
    console.log("[Backend] favorites ->", docs.length, "item(s)");
    res.json({ favorites: docs.map((doc) => toEquipment(doc, null)) });
});

// Whether a listing is already in this user's favorites.
app.get('/customer/:customerId/favorites/:equipmentId', checkCustomerId, async (req, res) => {
    const favorite = await favoritesCollection.findOne({
        customerId: req.customerId,
        equipmentId: req.params.equipmentId,
    });
    res.json({ isFavorite: Boolean(favorite) });
});

// Add a favorite (kept here so the favorites table can be populated).
app.post('/customer/:customerId/favorites/:equipmentId', checkCustomerId, async (req, res) => {
    console.log("[Backend] POST favorite", req.params.equipmentId);
    if (!ObjectId.isValid(req.params.equipmentId)) {
        return res.status(400).json({ error: "Invalid equipment id." });
    }
    await favoritesCollection.updateOne(
        { customerId: req.customerId, equipmentId: req.params.equipmentId },
        { $setOnInsert: { createdAt: new Date().toISOString() } },
        { upsert: true }
    );
    res.status(201).json({ success: true });
});

// Remove a favorite.
app.delete('/customer/:customerId/favorites/:equipmentId', checkCustomerId, async (req, res) => {
    console.log("[Backend] DELETE favorite", req.params.equipmentId);
    const result = await favoritesCollection.deleteOne({
        customerId: req.customerId,
        equipmentId: req.params.equipmentId,
    });
    if (result.deletedCount === 0) {
        return res.status(404).json({ error: "Favorite not found." });
    }
    res.json({ success: true });
});

// ---------------------------------------------------------------------------
// Admin API. Every route verifies that the caller is an admin user.
// ---------------------------------------------------------------------------

async function checkAdminId(req, res, next) {
    const adminId = req.params.adminId;
    console.log("[Backend] checking admin id:", adminId);

    if (!ObjectId.isValid(adminId)) {
        return res.status(400).json({ error: "Invalid admin id." });
    }
    const admin = await users.findOne({ _id: new ObjectId(adminId), role: "admin" });
    if (!admin) {
        console.warn("[Backend] admin not found");
        return res.status(403).json({ error: "Admin access required." });
    }
    req.adminId = adminId;
    next();
}

function toAdminUser(user) {
    return {
        id: user._id.toHexString(),
        name: user.name ?? "",
        email: user.email ?? "",
        role: user.role ?? "customer",
        createdAt: user.createdAt ?? null,
        phone: user.phone ?? "",
        image: user.image ?? "",
    };
}

const ADMIN_ROLES = ["customer", "owner", "admin"];

// Users: list, change role, remove account.
app.get('/admin/:adminId/users', checkAdminId, async (req, res) => {
    const docs = await users.find({}).sort({ createdAt: -1 }).toArray();
    console.log("[Backend] admin users ->", docs.length);
    res.json({ users: docs.map(toAdminUser) });
});

app.patch('/admin/:adminId/users/:userId', checkAdminId, async (req, res) => {
    const userId = req.params.userId;
    const role = req.body?.role;
    if (!ObjectId.isValid(userId) || !ADMIN_ROLES.includes(role)) {
        return res.status(400).json({ error: "A valid role is required." });
    }
    const result = await users.updateOne(
        { _id: new ObjectId(userId) },
        { $set: { role, updatedAt: new Date() } }
    );
    if (!result.matchedCount) return res.status(404).json({ error: "User not found." });
    const user = await users.findOne({ _id: new ObjectId(userId) });
    console.log("[Backend] role updated:", userId, "->", role);
    res.json({ user: toAdminUser(user) });
});

app.delete('/admin/:adminId/users/:userId', checkAdminId, async (req, res) => {
    const userId = req.params.userId;
    if (!ObjectId.isValid(userId)) {
        return res.status(400).json({ error: "Invalid user id." });
    }
    if (userId === req.adminId) {
        return res.status(400).json({ error: "You cannot delete your own account." });
    }
    const result = await users.deleteOne({ _id: new ObjectId(userId) });
    if (!result.deletedCount) return res.status(404).json({ error: "User not found." });
    await favoritesCollection.deleteMany({ customerId: userId });
    console.log("[Backend] user deleted:", userId);
    res.json({ success: true });
});

// Equipment: approve/reject, edit and delete any listing.
app.get('/admin/:adminId/equipment', checkAdminId, async (req, res) => {
    const docs = await equipmentCollection.find({}).sort({ createdAt: -1 }).toArray();
    console.log("[Backend] admin equipment ->", docs.length);
    res.json({ equipment: await attachOwners(docs) });
});

app.patch('/admin/:adminId/equipment/:id/status', checkAdminId, async (req, res) => {
    const status = req.body?.status;
    if (!ObjectId.isValid(req.params.id) || !["Pending", "Approved", "Rejected"].includes(status)) {
        return res.status(400).json({ error: "A valid status is required." });
    }
    const result = await equipmentCollection.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: { status } }
    );
    if (!result.matchedCount) return res.status(404).json({ error: "Equipment not found." });
    console.log("[Backend] equipment status:", req.params.id, "->", status);
    const doc = await equipmentCollection.findOne({ _id: new ObjectId(req.params.id) });
    const [equipment] = await attachOwners([doc]);
    res.json({ equipment });
});

app.patch('/admin/:adminId/equipment/:id', checkAdminId, async (req, res) => {
    const patch = readPatch(req.body);
    if (!ObjectId.isValid(req.params.id) || Object.keys(patch).length === 0) {
        return res.status(400).json({ error: "No editable fields were provided." });
    }
    const result = await equipmentCollection.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: patch }
    );
    if (!result.matchedCount) return res.status(404).json({ error: "Equipment not found." });
    const doc = await equipmentCollection.findOne({ _id: new ObjectId(req.params.id) });
    const [equipment] = await attachOwners([doc]);
    res.json({ equipment });
});

app.delete('/admin/:adminId/equipment/:id', checkAdminId, async (req, res) => {
    if (!ObjectId.isValid(req.params.id)) {
        return res.status(400).json({ error: "Invalid equipment id." });
    }
    const result = await equipmentCollection.deleteOne({ _id: new ObjectId(req.params.id) });
    if (!result.deletedCount) return res.status(404).json({ error: "Equipment not found." });
    await favoritesCollection.deleteMany({ equipmentId: req.params.id });
    await rentalsCollection.deleteMany({ equipmentId: req.params.id });
    console.log("[Backend] equipment deleted by admin:", req.params.id);
    res.json({ success: true });
});

// Rentals: all bookings with customer/owner details, plus status management.
app.get('/admin/:adminId/rentals', checkAdminId, async (req, res) => {
    const docs = await rentalsCollection.find({}).sort({ bookingDate: -1 }).toArray();
    const ids = (field) => [...new Set(
        docs.map((doc) => doc[field]?.toString()).filter((id) => id && ObjectId.isValid(id))
    )];
    const equipmentIds = ids("equipmentId");
    const userIds = ids("customerId");

    const equipmentDocs = equipmentIds.length
        ? await equipmentCollection.find({ _id: { $in: equipmentIds.map((id) => new ObjectId(id)) } }).toArray()
        : [];
    const ownerIds = [...new Set(equipmentDocs.map((item) => item.ownerId?.toString()).filter(Boolean))];
    const allUserIds = [...new Set([...userIds, ...ownerIds])].filter((id) => ObjectId.isValid(id));
    const userDocs = allUserIds.length
        ? await users.find({ _id: { $in: allUserIds.map((id) => new ObjectId(id)) } }).toArray()
        : [];

    const equipmentMap = new Map(equipmentDocs.map((item) => [item._id.toHexString(), item]));
    const userMap = new Map(userDocs.map((user) => [user._id.toHexString(), user]));

    const rentals = docs.map((doc) => {
        const equipment = equipmentMap.get(doc.equipmentId?.toString());
        const customer = userMap.get(doc.customerId?.toString());
        const owner = equipment?.ownerId ? userMap.get(equipment.ownerId.toString()) : null;
        return {
            ...toRental(doc),
            customerName: customer?.name ?? "",
            customerEmail: customer?.email ?? "",
            ownerId: equipment?.ownerId?.toString() ?? "",
            ownerName: owner?.name ?? "",
            ownerEmail: owner?.email ?? "",
        };
    });
    console.log("[Backend] admin rentals ->", rentals.length);
    res.json({ rentals });
});

app.patch('/admin/:adminId/rentals/:id', checkAdminId, async (req, res) => {
    const patch = {};
    if (PAYMENT_STATUSES.includes(req.body?.paymentStatus)) patch.paymentStatus = req.body.paymentStatus;
    if (BOOKING_STATUSES.includes(req.body?.bookingStatus)) patch.bookingStatus = req.body.bookingStatus;

    if (!ObjectId.isValid(req.params.id) || Object.keys(patch).length === 0) {
        return res.status(400).json({ error: "No valid status fields were provided." });
    }
    const result = await rentalsCollection.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: patch }
    );
    if (!result.matchedCount) return res.status(404).json({ error: "Rental not found." });
    const doc = await rentalsCollection.findOne({ _id: new ObjectId(req.params.id) });
    console.log("[Backend] rental updated:", req.params.id);
    res.json({ rental: toRental(doc) });
});

// ---------------------------------------------------------------------------
// Profile (shared by customer, owner and admin)
// ---------------------------------------------------------------------------

async function checkUserId(req, res, next) {
    const userId = req.params.userId;
    console.log("[Backend] checking user id:", userId);

    if (!ObjectId.isValid(userId)) {
        return res.status(400).json({ error: "Invalid user id." });
    }
    const user = await users.findOne({ _id: new ObjectId(userId) });
    if (!user) {
        console.warn("[Backend] user not found");
        return res.status(403).json({ error: "User not found." });
    }
    req.userDoc = user;
    next();
}

function toProfile(user) {
    return {
        id: user._id.toHexString(),
        name: user.name ?? "",
        email: user.email ?? "",
        image: user.image ?? "",
        phone: user.phone ?? "",
        address: user.address ?? "",
        role: user.role ?? "",
    };
}

function readProfilePatch(body) {
    const patch = {};
    for (const field of ["name", "email", "image", "phone", "address"]) {
        if (typeof body?.[field] === "string") patch[field] = body[field].trim();
    }
    if ("name" in patch && !patch.name) return null;
    if ("email" in patch && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(patch.email)) return null;
    return patch;
}

app.get('/profile/:userId', checkUserId, (req, res) => {
    console.log("[Backend] GET profile");
    res.json({ profile: toProfile(req.userDoc) });
});

app.patch('/profile/:userId', checkUserId, async (req, res) => {
    console.log("[Backend] PATCH profile");
    const patch = readProfilePatch(req.body);
    if (!patch || Object.keys(patch).length === 0) {
        return res.status(400).json({ error: "No valid profile fields were provided." });
    }
    if (patch.email) {
        const duplicate = await users.findOne({
            email: patch.email,
            _id: { $ne: req.userDoc._id },
        });
        if (duplicate) {
            return res.status(409).json({ error: "That email is already in use." });
        }
    }
    await users.updateOne(
        { _id: req.userDoc._id },
        { $set: { ...patch, updatedAt: new Date() } }
    );
    console.log("[Backend] profile updated:", req.params.userId);
    const updated = await users.findOne({ _id: req.userDoc._id });
    res.json({ profile: toProfile(updated) });
});

app.listen(port, () => {
    console.log(`equipora is running on port ${port}`)
})

export default app;
