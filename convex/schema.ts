import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  users: defineTable({
    clerkId: v.string(),
    email: v.string(),
    firstName: v.optional(v.string()),
    lastName: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
    role: v.string(),
    createdAt: v.number(),
  })
    .index("by_clerk_id", ["clerkId"])
    .index("by_email", ["email"]),

  applications: defineTable({
    userId: v.string(),
    userFirstName: v.optional(v.string()),
    userLastName: v.optional(v.string()),
    userEmail: v.optional(v.string()),
    userPhone: v.optional(v.string()),
    destination: v.string(),
    visaType: v.string(),
    applicantName: v.string(),
    passportNumber: v.optional(v.string()),
    travelDate: v.string(),
    returnDate: v.optional(v.string()),
    purpose: v.string(),
    notes: v.optional(v.string()),
    status: v.string(),
    appointmentDate: v.optional(v.string()),
    adminNotes: v.optional(v.string()),
    price: v.optional(v.number()),
    isPaid: v.boolean(),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_status", ["status"])
    .index("by_updated", ["updatedAt"]),

  messages: defineTable({
    applicationId: v.id("applications"),
    senderId: v.string(),
    senderName: v.string(),
    content: v.string(),
    isFromAdmin: v.boolean(),
    readBy: v.optional(v.array(v.string())),
  }).index("by_application", ["applicationId"]),
});
