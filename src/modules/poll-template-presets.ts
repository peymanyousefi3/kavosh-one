import { pollDefinition } from './poll-definition.ts';

const id=(n:number)=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const content={
 en:{feedback:'Parent class feedback',description:'An editable starting point. Adapt the questions before publishing.',enjoyment:'How is your child enjoying the classes?',ratings:['Very much','Mostly','Neutral','Not much','Not at all'],topics:'What would you like to hear more about?',topicOptions:['Learning progress','Homework','Class schedule','Events and competitions'],notes:'Anything else you would like us to know?',availability:'Class time preferences',timeDescription:'Times refer to the class time zone. This survey does not reschedule a class.',times:'Which times could work for your family?',timeOptions:['Weekday afternoons','Weekday evenings','Weekend mornings','Weekend afternoons']},
 fr:{feedback:'Avis des parents sur les cours',description:'Un point de départ modifiable. Adaptez les questions avant la publication.',enjoyment:'Votre enfant apprécie-t-il les cours ?',ratings:['Beaucoup','Plutôt oui','Neutre','Peu','Pas du tout'],topics:'Sur quels sujets souhaitez-vous recevoir plus d’informations ?',topicOptions:['Progrès dans les apprentissages','Devoirs','Horaire des cours','Événements et compétitions'],notes:'Souhaitez-vous nous faire part d’autre chose ?',availability:'Préférences pour les horaires des cours',timeDescription:'Les horaires correspondent au fuseau horaire du cours. Ce sondage ne modifie pas l’horaire d’un cours.',times:'Quels créneaux pourraient convenir à votre famille ?',timeOptions:['Après-midi en semaine','Soirs de semaine','Matins de fin de semaine','Après-midi de fin de semaine']},
 'zh-CN':{feedback:'家长课程反馈',description:'可编辑的起点。请在发布前根据需要调整问题。',enjoyment:'您的孩子喜欢这些课程吗？',ratings:['非常喜欢','比较喜欢','一般','不太喜欢','完全不喜欢'],topics:'您希望了解哪些方面的更多信息？',topicOptions:['学习进展','家庭作业','课程安排','活动与竞赛'],notes:'您还有其他想告诉我们的事情吗？',availability:'上课时间偏好',timeDescription:'时间以课程所在时区为准。本问卷不会更改课程安排。',times:'哪些时间段可能适合您的家庭？',timeOptions:['工作日下午','工作日晚上','周末上午','周末下午']}
};
// Factory suggestions only. Saving creates an ordinary editable, approved
// academy-owned template; these never create polls, audiences or answers.
export const pollTemplatePresets=Object.entries(content).flatMap(([locale,t])=>[
 {key:'parent-feedback:'+locale,active:true,responseUnit:'student_family',respondentMode:'guardians',definition:pollDefinition.parse({title:t.feedback,description:t.description,locale,questions:[
  {id:id(101),kind:'single',prompt:t.enjoyment,required:true,options:t.ratings.map((label,n)=>({id:id(201+n),label}))},
  {id:id(102),kind:'multiple',prompt:t.topics,required:false,maxSelections:4,options:t.topicOptions.map((label,n)=>({id:id(206+n),label}))},
  {id:id(103),kind:'text',prompt:t.notes,required:false,maxLength:2000}
 ]})},
 {key:'class-time-preferences:'+locale,active:true,responseUnit:'student_family',respondentMode:'guardians',definition:pollDefinition.parse({title:t.availability,description:t.timeDescription,locale,questions:[
  {id:id(301),kind:'multiple',prompt:t.times,required:true,maxSelections:4,options:t.timeOptions.map((label,n)=>({id:id(401+n),label}))},
  {id:id(302),kind:'text',prompt:t.notes,required:false,maxLength:1000}
 ]})}
]);
