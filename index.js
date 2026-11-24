import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import { MongoClient, ObjectId } from 'mongodb';

const app = express();
const port = process.env.PORT || 5000;

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

app.get('/', (req, res) => {
    res.send('equipora is looping')
})

app.get('/user', async (req, res) => {
    const cursor = users.find({});
    const result = await cursor.toArray();
    res.send(result);
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

app.listen(port, () => {
    console.log(`equipora is running on port ${port}`)
})

export default app;
