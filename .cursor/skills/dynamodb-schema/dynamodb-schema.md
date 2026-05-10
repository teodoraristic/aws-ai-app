# DynamoDB — Single table: ConsultationsApp

## Key schema

Users:
  PK: USER#{cognitoSub}        SK: PROFILE
  GSI1PK: ROLE#{professor|student}    GSI1SK: USER#{cognitoSub}

Professor schedule (recurring weekly availability):
  PK: USER#{professorId}       SK: SCHEDULE#{MON|TUE|WED|THU|FRI}
  PK: USER#{professorId}       SK: SCHEDULE#DATE#{YYYY-MM-DD}  ← one-off override

Slots (generated from schedule, or created manually):
  PK: PROFESSOR#{professorId}  SK: SLOT#{YYYY-MM-DD}T{HH:MM}
  GSI1PK: SLOT_STATUS#{available|full}
  GSI1SK: PROFESSOR#{professorId}#DATE#{YYYY-MM-DD}T{HH:MM}
  Fields: status, topic, maxParticipants, currentParticipants, professorId, date, time, createdAt

Consultations (each booking = one item per student):
  PK: CONSULTATION#{consultationId}   SK: METADATA
  GSI1PK: PROFESSOR#{professorId}     GSI1SK: DATE#{YYYY-MM-DD}T{HH:MM}
  GSI2PK: STUDENT#{studentId}         GSI2SK: DATE#{YYYY-MM-DD}T{HH:MM}
  Fields: status (booked|cancelled), slotSK, studentId, professorId, date, time, topic, note, createdAt

Chat sessions:
  PK: SESSION#{sessionId}      SK: MSG#{timestamp}#{uuid}
  Fields: role (user|assistant), content, ttl (unix now+7200)

Config:
  PK: CONFIG#{key}             SK: VALUE