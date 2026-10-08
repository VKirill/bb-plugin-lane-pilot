import { writerFallbackKeys } from "../../../../writer-fallbacks";
import { casUpsertSettings, sectionBindingId } from "../../../../database";
import { compatibleReasoningLevel, compatibleServiceTier, findModelIn } from "@lane-pilot/models";
import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { rpcContract } from "../../../../contracts";
import type { ServerCore } from "../../../../server/core";
import type { Services } from "../../../../server/services";

export function selectionsRpc(ctx: ServerCore, services: Services) {
  const { bb, db, host } = ctx;
  return {
    save_writer_selection: async ({ projectId, sectionId, threadId, selectedBinding, providerId, model: modelId, reasoningLevel, serviceTier, expectedVersions }) => {
      const reject = (code:"invalid_choice"|"incompatible_setting"|"setup_required"|"writer_binding_ambiguous"|"writer_host_offline"|"catalog_unavailable", key:string, message:string) => ({
        ok:false, conflict:false, values:{}, versions:{}, validation:{ code, key, params:[key, message] },
      });
      const catalogHost = await services.selectionCatalogHost(projectId, threadId, selectedBinding);
      if (!catalogHost.ok) return { ok:false, conflict:false, values:{}, versions:{}, validation:catalogHost.validation };
      const catalogHostId = catalogHost.hostId;
      let providers:Awaited<ReturnType<typeof bb.sdk.providers.list>>;
      let catalog:Awaited<ReturnType<typeof bb.sdk.providers.models>>;
      try {
        [providers, catalog] = await Promise.all([
          bb.sdk.providers.list({ hostId:catalogHostId }),
          bb.sdk.providers.models({ providerId, hostId:catalogHostId }),
        ]);
      } catch {
        return reject("catalog_unavailable", "writer.provider", catalogHostId);
      }
      const provider = providers.find((item) => item.id === providerId && item.available);
      if (!provider) return reject("invalid_choice", "writer.provider", `provider ${providerId} is unavailable on this host`);
      const selectedModel = findModelIn(catalog.models, modelId);
      if (!selectedModel) return reject("invalid_choice", "writer.model", `model ${modelId} is not in the live catalog for ${providerId}`);
      const supportedEfforts = selectedModel.supportedReasoningEfforts.map((item) => item.reasoningEffort);
      const catalogDefault = typeof selectedModel.defaultReasoningEffort === "string"
        ? selectedModel.defaultReasoningEffort
        : undefined;
      const selectedEffort = compatibleReasoningLevel(reasoningLevel, supportedEfforts, catalogDefault);
      if (!selectedEffort) {
        const reason = catalogDefault && !supportedEfforts.includes(catalogDefault)
          ? `malformed_catalog_defaultReasoningEffort:${catalogDefault}`
          : `model supports: ${supportedEfforts.join(", ") || "none"}`;
        return reject("incompatible_setting", "writer.reasoning_effort", reason);
      }
      const supportedTiers = provider.serviceTiers?.map((tier) => tier.id) ?? [];
      const selectedTier = compatibleServiceTier(serviceTier, supportedTiers);
      if (serviceTier && supportedTiers.length > 0 && !selectedTier) {
        return reject("invalid_choice", "writer.service_tier", `provider supports: ${supportedTiers.join(", ") || "no service tiers"}`);
      }
      return casUpsertSettings(db, {
        projectId,
        bindingId: sectionId ? sectionBindingId(sectionId) : "",
        changes:[
          { key:"writer.provider", value:providerId, expectedVersion:expectedVersions["writer.provider"] },
          { key:"writer.model", value:modelId, expectedVersion:expectedVersions["writer.model"] },
          { key:"writer.reasoning_effort", value:selectedEffort, expectedVersion:expectedVersions["writer.reasoning_effort"] },
          { key:"writer.service_tier", value:selectedTier === "fast" ? "fast" : "standard", expectedVersion:expectedVersions["writer.service_tier"] },
        ],
      }, { nativeWriterSelection:true });
    },
    save_memory_selection: async ({projectId,sectionId, providerId, model: modelId, reasoningLevel, serviceTier, expectedVersions }) => {
      const reject = (code:"invalid_choice"|"incompatible_setting"|"setup_required"|"writer_binding_ambiguous"|"writer_host_offline"|"catalog_unavailable", key:string, message:string) => ({
        ok:false, conflict:false, values:{}, versions:{}, validation:{code,key,params:[key,message]},
      });
      const binding=await services.resolveProjectWriterHost({projectId});
      if(binding.status==="catalog_unavailable") return reject("catalog_unavailable","project.sources",binding.reason);
      if(binding.status==="setup_required") return reject("setup_required","project.sources","project_folders_source_required");
      if(binding.status==="ambiguous") return reject("writer_binding_ambiguous","project.sources","select_existing_project_binding");
      if(binding.status==="offline") return reject("writer_host_offline","project.sources",binding.hostId);
      const catalogHostId=binding.hostId;
      let providers:Awaited<ReturnType<typeof bb.sdk.providers.list>>;
      let catalog:Awaited<ReturnType<typeof bb.sdk.providers.models>>;
      try {
        [providers,catalog]=await Promise.all([
          bb.sdk.providers.list({hostId:catalogHostId}),
          bb.sdk.providers.models({providerId,hostId:catalogHostId}),
        ]);
      } catch {
        return reject("catalog_unavailable","memory.provider",catalogHostId);
      }
      const provider=providers.find((item)=>item.id===providerId&&item.available);
      if(!provider) return reject("invalid_choice","memory.provider",`provider ${providerId} is unavailable on this host`);
      const selectedModel=catalog.models.find((item)=>item.id===modelId||item.model===modelId);
      if(!selectedModel) return reject("invalid_choice","memory.model",`model ${modelId} is not in the live catalog for ${providerId}`);
      const supportedEfforts=selectedModel.supportedReasoningEfforts.map((item)=>item.reasoningEffort);
      if(!supportedEfforts.includes(reasoningLevel)) return reject("incompatible_setting","memory.reasoning_effort",`model supports: ${supportedEfforts.join(", ")}`);
      const supportedTiers=provider.serviceTiers?.map((tier)=>tier.id)??[];
      const selectedTier=serviceTier??(provider.capabilities.supportsServiceTier&&supportedTiers.includes("default")?"default":null);
      if(selectedTier&&!supportedTiers.includes(selectedTier)) return reject("invalid_choice","memory.service_tier",`provider supports: ${supportedTiers.join(", ")||"no service tiers"}`);
      return casUpsertSettings(db,{projectId,bindingId:sectionId?sectionBindingId(sectionId):"",changes:[
        {key:"memory.provider",value:providerId,expectedVersion:expectedVersions["memory.provider"]},
        {key:"memory.model",value:modelId,expectedVersion:expectedVersions["memory.model"]},
        {key:"memory.reasoning_effort",value:reasoningLevel,expectedVersion:expectedVersions["memory.reasoning_effort"]},
        {key:"memory.service_tier",value:selectedTier==="fast"?"fast":"standard",expectedVersion:expectedVersions["memory.service_tier"]},
      ]},{nativeWriterSelection:true});
    },
    save_night_review_selection: async ({projectId,sectionId,providerId,model:modelId,reasoningLevel,serviceTier,expectedVersions})=>{
      const reject=(code:"invalid_choice"|"incompatible_setting"|"catalog_unavailable",key:string,message:string)=>({ok:false,conflict:false,values:{},versions:{},validation:{code,key,params:[key,message]}});
      const catalogHost=await services.selectionCatalogHost(projectId);
      if(!catalogHost.ok) return {ok:false,conflict:false,values:{},versions:{},validation:catalogHost.validation};
      let providers:Awaited<ReturnType<typeof bb.sdk.providers.list>>,catalog:Awaited<ReturnType<typeof bb.sdk.providers.models>>;
      try {[providers,catalog]=await Promise.all([bb.sdk.providers.list({hostId:catalogHost.hostId}),bb.sdk.providers.models({providerId,hostId:catalogHost.hostId})]);}
      catch {return reject("catalog_unavailable","night_review.provider",catalogHost.hostId);}
      const provider=providers.find((item)=>item.id===providerId&&item.available);
      if(!provider) return reject("invalid_choice","night_review.provider",`provider ${providerId} is unavailable on this host`);
      const selectedModel=catalog.models.find((item)=>item.id===modelId||item.model===modelId);
      if(!selectedModel) return reject("invalid_choice","night_review.model",`model ${modelId} is not in the live catalog for ${providerId}`);
      const efforts=selectedModel.supportedReasoningEfforts.map((item)=>item.reasoningEffort);
      if(!efforts.includes(reasoningLevel)) return reject("incompatible_setting","night_review.reasoning_effort",`model supports: ${efforts.join(", ")}`);
      const tiers=provider.serviceTiers?.map((tier)=>tier.id)??[];
      const selectedTier=serviceTier??(provider.capabilities.supportsServiceTier&&tiers.includes("default")?"default":null);
      if(selectedTier&&!tiers.includes(selectedTier)) return reject("invalid_choice","night_review.service_tier",`provider supports: ${tiers.join(", ")||"no service tiers"}`);
      return casUpsertSettings(db,{projectId,bindingId:sectionId?sectionBindingId(sectionId):"",changes:[
        {key:"night_review.provider",value:providerId,expectedVersion:expectedVersions["night_review.provider"]},
        {key:"night_review.model",value:modelId,expectedVersion:expectedVersions["night_review.model"]},
        {key:"night_review.reasoning_effort",value:reasoningLevel,expectedVersion:expectedVersions["night_review.reasoning_effort"]},
        {key:"night_review.service_tier",value:selectedTier==="fast"?"fast":"standard",expectedVersion:expectedVersions["night_review.service_tier"]},
      ]},{nativeWriterSelection:true});
    },
    save_docs_selection: async ({projectId,sectionId,providerId,model:modelId,reasoningLevel,serviceTier,expectedVersions})=>{
      const reject=(code:"invalid_choice"|"incompatible_setting"|"catalog_unavailable",key:string,message:string)=>({ok:false,conflict:false,values:{},versions:{},validation:{code,key,params:[key,message]}});
      const catalogHost=await services.selectionCatalogHost(projectId);
      if(!catalogHost.ok) return {ok:false,conflict:false,values:{},versions:{},validation:catalogHost.validation};
      let providers:Awaited<ReturnType<typeof bb.sdk.providers.list>>,catalog:Awaited<ReturnType<typeof bb.sdk.providers.models>>;
      try {[providers,catalog]=await Promise.all([bb.sdk.providers.list({hostId:catalogHost.hostId}),bb.sdk.providers.models({providerId,hostId:catalogHost.hostId})]);}
      catch {return reject("catalog_unavailable","docs.provider",catalogHost.hostId);}
      const provider=providers.find((item)=>item.id===providerId&&item.available);
      if(!provider) return reject("invalid_choice","docs.provider",`provider ${providerId} is unavailable on this host`);
      const selectedModel=catalog.models.find((item)=>item.id===modelId||item.model===modelId);
      if(!selectedModel) return reject("invalid_choice","docs.model",`model ${modelId} is not in the live catalog for ${providerId}`);
      const efforts=selectedModel.supportedReasoningEfforts.map((item)=>item.reasoningEffort);
      if(!efforts.includes(reasoningLevel)) return reject("incompatible_setting","docs.reasoning_effort",`model supports: ${efforts.join(", ")}`);
      const tiers=provider.serviceTiers?.map((tier)=>tier.id)??[];
      const selectedTier=serviceTier??(provider.capabilities.supportsServiceTier&&tiers.includes("default")?"default":null);
      if(selectedTier&&!tiers.includes(selectedTier)) return reject("invalid_choice","docs.service_tier",`provider supports: ${tiers.join(", ")||"no service tiers"}`);
      return casUpsertSettings(db,{projectId,bindingId:sectionId?sectionBindingId(sectionId):"",changes:[
        {key:"docs.provider",value:providerId,expectedVersion:expectedVersions["docs.provider"]},
        {key:"docs.model",value:modelId,expectedVersion:expectedVersions["docs.model"]},
        {key:"docs.reasoning_effort",value:reasoningLevel,expectedVersion:expectedVersions["docs.reasoning_effort"]},
        {key:"docs.service_tier",value:selectedTier==="fast"?"fast":"standard",expectedVersion:expectedVersions["docs.service_tier"]},
      ]},{nativeWriterSelection:true});
    },
    save_project_life_selection: async ({projectId,sectionId,providerId,model:modelId,reasoningLevel,serviceTier,expectedVersions})=>{
      const reject=(code:"invalid_choice"|"incompatible_setting"|"catalog_unavailable",key:string,message:string)=>({ok:false,conflict:false,values:{},versions:{},validation:{code,key,params:[key,message]}});
      const catalogHost=await services.selectionCatalogHost(projectId);
      if(!catalogHost.ok) return {ok:false,conflict:false,values:{},versions:{},validation:catalogHost.validation};
      let providers:Awaited<ReturnType<typeof bb.sdk.providers.list>>,catalog:Awaited<ReturnType<typeof bb.sdk.providers.models>>;
      try {[providers,catalog]=await Promise.all([bb.sdk.providers.list({hostId:catalogHost.hostId}),bb.sdk.providers.models({providerId,hostId:catalogHost.hostId})]);}
      catch {return reject("catalog_unavailable","project_life.provider",catalogHost.hostId);}
      const provider=providers.find((item)=>item.id===providerId&&item.available);
      if(!provider) return reject("invalid_choice","project_life.provider",`provider ${providerId} is unavailable on this host`);
      const selectedModel=catalog.models.find((item)=>item.id===modelId||item.model===modelId);
      if(!selectedModel) return reject("invalid_choice","project_life.model",`model ${modelId} is not in the live catalog for ${providerId}`);
      const efforts=selectedModel.supportedReasoningEfforts.map((item)=>item.reasoningEffort);
      if(!efforts.includes(reasoningLevel)) return reject("incompatible_setting","project_life.reasoning_effort",`model supports: ${efforts.join(", ")}`);
      const tiers=provider.serviceTiers?.map((tier)=>tier.id)??[];
      const selectedTier=serviceTier??(provider.capabilities.supportsServiceTier&&tiers.includes("default")?"default":null);
      if(selectedTier&&!tiers.includes(selectedTier)) return reject("invalid_choice","project_life.service_tier",`provider supports: ${tiers.join(", ")||"no service tiers"}`);
      return casUpsertSettings(db,{projectId,bindingId:sectionId?sectionBindingId(sectionId):"",changes:[
        {key:"project_life.provider",value:providerId,expectedVersion:expectedVersions["project_life.provider"]},
        {key:"project_life.model",value:modelId,expectedVersion:expectedVersions["project_life.model"]},
        {key:"project_life.reasoning_effort",value:reasoningLevel,expectedVersion:expectedVersions["project_life.reasoning_effort"]},
        {key:"project_life.service_tier",value:selectedTier==="fast"?"fast":"standard",expectedVersion:expectedVersions["project_life.service_tier"]},
      ]},{nativeWriterSelection:true});
    },
    save_pm_read_selection: async ({projectId,sectionId,providerId,model:modelId,reasoningLevel,serviceTier,expectedVersions})=>{
      const reject=(code:"invalid_choice"|"incompatible_setting"|"catalog_unavailable",key:string,message:string)=>({ok:false,conflict:false,values:{},versions:{},validation:{code,key,params:[key,message]}});
      const catalogHost=await services.selectionCatalogHost(projectId);
      if(!catalogHost.ok) return {ok:false,conflict:false,values:{},versions:{},validation:catalogHost.validation};
      let providers:Awaited<ReturnType<typeof bb.sdk.providers.list>>,catalog:Awaited<ReturnType<typeof bb.sdk.providers.models>>;
      try {[providers,catalog]=await Promise.all([bb.sdk.providers.list({hostId:catalogHost.hostId}),bb.sdk.providers.models({providerId,hostId:catalogHost.hostId})]);}
      catch {return reject("catalog_unavailable","pm_read.provider",catalogHost.hostId);}
      const provider=providers.find((item)=>item.id===providerId&&item.available);
      if(!provider) return reject("invalid_choice","pm_read.provider",`provider ${providerId} is unavailable on this host`);
      const selectedModel=catalog.models.find((item)=>item.id===modelId||item.model===modelId);
      if(!selectedModel) return reject("invalid_choice","pm_read.model",`model ${modelId} is not in the live catalog for ${providerId}`);
      const efforts=selectedModel.supportedReasoningEfforts.map((item)=>item.reasoningEffort);
      if(!efforts.includes(reasoningLevel)) return reject("incompatible_setting","pm_read.reasoning_effort",`model supports: ${efforts.join(", ")}`);
      const tiers=provider.serviceTiers?.map((tier)=>tier.id)??[];
      const selectedTier=serviceTier??(provider.capabilities.supportsServiceTier&&tiers.includes("default")?"default":null);
      if(selectedTier&&!tiers.includes(selectedTier)) return reject("invalid_choice","pm_read.service_tier",`provider supports: ${tiers.join(", ")||"no service tiers"}`);
      return casUpsertSettings(db,{projectId,bindingId:sectionId?sectionBindingId(sectionId):"",changes:[
        {key:"pm_read.provider",value:providerId,expectedVersion:expectedVersions["pm_read.provider"]},
        {key:"pm_read.model",value:modelId,expectedVersion:expectedVersions["pm_read.model"]},
        {key:"pm_read.reasoning_effort",value:reasoningLevel,expectedVersion:expectedVersions["pm_read.reasoning_effort"]},
        {key:"pm_read.service_tier",value:selectedTier==="fast"?"fast":"standard",expectedVersion:expectedVersions["pm_read.service_tier"]},
      ]},{nativeWriterSelection:true});
    },
    save_onboarding_selection: async ({projectId,sectionId,providerId,model:modelId,reasoningLevel,serviceTier,expectedVersions})=>{
      const reject=(code:"invalid_choice"|"incompatible_setting"|"catalog_unavailable",key:string,message:string)=>({ok:false,conflict:false,values:{},versions:{},validation:{code,key,params:[key,message]}});
      const catalogHost=await services.selectionCatalogHost(projectId);
      if(!catalogHost.ok) return {ok:false,conflict:false,values:{},versions:{},validation:catalogHost.validation};
      let providers:Awaited<ReturnType<typeof bb.sdk.providers.list>>,catalog:Awaited<ReturnType<typeof bb.sdk.providers.models>>;
      try {[providers,catalog]=await Promise.all([bb.sdk.providers.list({hostId:catalogHost.hostId}),bb.sdk.providers.models({providerId,hostId:catalogHost.hostId})]);}
      catch {return reject("catalog_unavailable","onboarding.provider",catalogHost.hostId);}
      const provider=providers.find((item)=>item.id===providerId&&item.available);
      if(!provider) return reject("invalid_choice","onboarding.provider",`provider ${providerId} is unavailable on this host`);
      const selectedModel=catalog.models.find((item)=>item.id===modelId||item.model===modelId);
      if(!selectedModel) return reject("invalid_choice","onboarding.model",`model ${modelId} is not in the live catalog for ${providerId}`);
      const efforts=selectedModel.supportedReasoningEfforts.map((item)=>item.reasoningEffort);
      if(!efforts.includes(reasoningLevel)) return reject("incompatible_setting","onboarding.reasoning_effort",`model supports: ${efforts.join(", ")}`);
      const tiers=provider.serviceTiers?.map((tier)=>tier.id)??[];
      const selectedTier=serviceTier??(provider.capabilities.supportsServiceTier&&tiers.includes("default")?"default":null);
      if(selectedTier&&!tiers.includes(selectedTier)) return reject("invalid_choice","onboarding.service_tier",`provider supports: ${tiers.join(", ")||"no service tiers"}`);
      return casUpsertSettings(db,{projectId,bindingId:sectionId?sectionBindingId(sectionId):"",changes:[
        {key:"onboarding.provider",value:providerId,expectedVersion:expectedVersions["onboarding.provider"]},
        {key:"onboarding.model",value:modelId,expectedVersion:expectedVersions["onboarding.model"]},
        {key:"onboarding.reasoning_effort",value:reasoningLevel,expectedVersion:expectedVersions["onboarding.reasoning_effort"]},
        {key:"onboarding.service_tier",value:selectedTier==="fast"?"fast":"standard",expectedVersion:expectedVersions["onboarding.service_tier"]},
      ]},{nativeWriterSelection:true});
    },
    save_plan_critique_selection: async ({projectId,sectionId,providerId,model:modelId,reasoningLevel,serviceTier,expectedVersions})=>{
      const reject=(code:"invalid_choice"|"incompatible_setting"|"catalog_unavailable",key:string,message:string)=>({ok:false,conflict:false,values:{},versions:{},validation:{code,key,params:[key,message]}});
      const catalogHost=await services.selectionCatalogHost(projectId);
      if(!catalogHost.ok) return {ok:false,conflict:false,values:{},versions:{},validation:catalogHost.validation};
      let providers:Awaited<ReturnType<typeof bb.sdk.providers.list>>,catalog:Awaited<ReturnType<typeof bb.sdk.providers.models>>;
      try {[providers,catalog]=await Promise.all([bb.sdk.providers.list({hostId:catalogHost.hostId}),bb.sdk.providers.models({providerId,hostId:catalogHost.hostId})]);}
      catch {return reject("catalog_unavailable","plan_critique.provider",catalogHost.hostId);}
      const provider=providers.find((item)=>item.id===providerId&&item.available);
      if(!provider) return reject("invalid_choice","plan_critique.provider",`provider ${providerId} is unavailable on this host`);
      const selectedModel=catalog.models.find((item)=>item.id===modelId||item.model===modelId);
      if(!selectedModel) return reject("invalid_choice","plan_critique.model",`model ${modelId} is not in the live catalog for ${providerId}`);
      const efforts=selectedModel.supportedReasoningEfforts.map((item)=>item.reasoningEffort);
      if(!efforts.includes(reasoningLevel)) return reject("incompatible_setting","plan_critique.reasoning_effort",`model supports: ${efforts.join(", ")}`);
      const tiers=provider.serviceTiers?.map((tier)=>tier.id)??[];
      const selectedTier=serviceTier??(provider.capabilities.supportsServiceTier&&tiers.includes("default")?"default":null);
      if(selectedTier&&!tiers.includes(selectedTier)) return reject("invalid_choice","plan_critique.service_tier",`provider supports: ${tiers.join(", ")||"no service tiers"}`);
      return casUpsertSettings(db,{projectId,bindingId:sectionId?sectionBindingId(sectionId):"",changes:[
        {key:"plan_critique.provider",value:providerId,expectedVersion:expectedVersions["plan_critique.provider"]},
        {key:"plan_critique.model",value:modelId,expectedVersion:expectedVersions["plan_critique.model"]},
        {key:"plan_critique.reasoning_effort",value:reasoningLevel,expectedVersion:expectedVersions["plan_critique.reasoning_effort"]},
        {key:"plan_critique.service_tier",value:selectedTier==="fast"?"fast":"standard",expectedVersion:expectedVersions["plan_critique.service_tier"]},
      ]},{nativeWriterSelection:true});
    },
    save_code_critique_selection: async ({projectId,sectionId,providerId,model:modelId,reasoningLevel,serviceTier,expectedVersions})=>{
      const reject=(code:"invalid_choice"|"incompatible_setting"|"catalog_unavailable",key:string,message:string)=>({ok:false,conflict:false,values:{},versions:{},validation:{code,key,params:[key,message]}});
      const catalogHost=await services.selectionCatalogHost(projectId);
      if(!catalogHost.ok) return {ok:false,conflict:false,values:{},versions:{},validation:catalogHost.validation};
      let providers:Awaited<ReturnType<typeof bb.sdk.providers.list>>,catalog:Awaited<ReturnType<typeof bb.sdk.providers.models>>;
      try {[providers,catalog]=await Promise.all([bb.sdk.providers.list({hostId:catalogHost.hostId}),bb.sdk.providers.models({providerId,hostId:catalogHost.hostId})]);}
      catch {return reject("catalog_unavailable","code_critique.provider",catalogHost.hostId);}
      const provider=providers.find((item)=>item.id===providerId&&item.available);
      if(!provider) return reject("invalid_choice","code_critique.provider",`provider ${providerId} is unavailable on this host`);
      const selectedModel=catalog.models.find((item)=>item.id===modelId||item.model===modelId);
      if(!selectedModel) return reject("invalid_choice","code_critique.model",`model ${modelId} is not in the live catalog for ${providerId}`);
      const efforts=selectedModel.supportedReasoningEfforts.map((item)=>item.reasoningEffort);
      if(!efforts.includes(reasoningLevel)) return reject("incompatible_setting","code_critique.reasoning_effort",`model supports: ${efforts.join(", ")}`);
      const tiers=provider.serviceTiers?.map((tier)=>tier.id)??[];
      const selectedTier=serviceTier??(provider.capabilities.supportsServiceTier&&tiers.includes("default")?"default":null);
      if(selectedTier&&!tiers.includes(selectedTier)) return reject("invalid_choice","code_critique.service_tier",`provider supports: ${tiers.join(", ")||"no service tiers"}`);
      return casUpsertSettings(db,{projectId,bindingId:sectionId?sectionBindingId(sectionId):"",changes:[
        {key:"code_critique.provider",value:providerId,expectedVersion:expectedVersions["code_critique.provider"]},
        {key:"code_critique.model",value:modelId,expectedVersion:expectedVersions["code_critique.model"]},
        {key:"code_critique.reasoning_effort",value:reasoningLevel,expectedVersion:expectedVersions["code_critique.reasoning_effort"]},
        {key:"code_critique.service_tier",value:selectedTier==="fast"?"fast":"standard",expectedVersion:expectedVersions["code_critique.service_tier"]},
      ]},{nativeWriterSelection:true});
    },
    save_council_seat_selection: async ({projectId,sectionId,seat,providerId,model:modelId,reasoningLevel,expectedVersions})=>{
      const reject=(code:"invalid_choice"|"incompatible_setting"|"catalog_unavailable",key:string,message:string)=>({ok:false,conflict:false,values:{},versions:{},validation:{code,key,params:[key,message]}});
      const keys={provider:`council.${seat}.provider`,model:`council.${seat}.model`,effort:`council.${seat}.reasoning_effort`};
      const catalogHost=await services.selectionCatalogHost(projectId);
      if(!catalogHost.ok) return {ok:false,conflict:false,values:{},versions:{},validation:catalogHost.validation};
      let providers:Awaited<ReturnType<typeof bb.sdk.providers.list>>,catalog:Awaited<ReturnType<typeof bb.sdk.providers.models>>;
      try {[providers,catalog]=await Promise.all([bb.sdk.providers.list({hostId:catalogHost.hostId}),bb.sdk.providers.models({providerId,hostId:catalogHost.hostId})]);}
      catch {return reject("catalog_unavailable",keys.provider,catalogHost.hostId);}
      if(!providers.find((item)=>item.id===providerId&&item.available)) return reject("invalid_choice",keys.provider,`provider ${providerId} is unavailable on this host`);
      const selectedModel=catalog.models.find((item)=>item.id===modelId||item.model===modelId);
      if(!selectedModel) return reject("invalid_choice",keys.model,`model ${modelId} is not in the live catalog for ${providerId}`);
      const efforts=selectedModel.supportedReasoningEfforts.map((item)=>item.reasoningEffort);
      if(!efforts.includes(reasoningLevel)) return reject("incompatible_setting",keys.effort,`model supports: ${efforts.join(", ")}`);
      return casUpsertSettings(db,{projectId,bindingId:sectionId?sectionBindingId(sectionId):"",changes:[
        {key:keys.provider,value:providerId,expectedVersion:expectedVersions[keys.provider]??0},
        {key:keys.model,value:modelId,expectedVersion:expectedVersions[keys.model]??0},
        {key:keys.effort,value:reasoningLevel,expectedVersion:expectedVersions[keys.effort]??0},
      ]},{nativeWriterSelection:true});
    },
    save_writer_fallback_selection: async ({projectId,sectionId,slot,off,providerId,model:modelId,reasoningLevel,expectedVersions})=>{
      const reject=(code:"invalid_choice"|"incompatible_setting"|"catalog_unavailable",key:string,message:string)=>({ok:false,conflict:false,values:{},versions:{},validation:{code,key,params:[key,message]}});
      const keys=writerFallbackKeys(slot);
      const store=(provider:string,model:string,effort:string)=>casUpsertSettings(db,{projectId,bindingId:sectionId?sectionBindingId(sectionId):"",changes:[
        {key:keys.provider,value:provider,expectedVersion:expectedVersions[keys.provider]??0},
        {key:keys.model,value:model,expectedVersion:expectedVersions[keys.model]??0},
        {key:keys.effort,value:effort,expectedVersion:expectedVersions[keys.effort]??0},
      ]},{nativeWriterSelection:true});
      if(off) return store("","","");
      if(!providerId||!modelId||!reasoningLevel) return reject("invalid_choice",keys.provider,"provider, model and reasoning level are required");
      const catalogHost=await services.selectionCatalogHost(projectId);
      if(!catalogHost.ok) return {ok:false,conflict:false,values:{},versions:{},validation:catalogHost.validation};
      let providers:Awaited<ReturnType<typeof bb.sdk.providers.list>>,catalog:Awaited<ReturnType<typeof bb.sdk.providers.models>>;
      try {[providers,catalog]=await Promise.all([bb.sdk.providers.list({hostId:catalogHost.hostId}),bb.sdk.providers.models({providerId,hostId:catalogHost.hostId})]);}
      catch {return reject("catalog_unavailable",keys.provider,catalogHost.hostId);}
      if(!providers.find((item)=>item.id===providerId&&item.available)) return reject("invalid_choice",keys.provider,`provider ${providerId} is unavailable on this host`);
      const selectedModel=catalog.models.find((item)=>item.id===modelId||item.model===modelId);
      if(!selectedModel) return reject("invalid_choice",keys.model,`model ${modelId} is not in the live catalog for ${providerId}`);
      const efforts=selectedModel.supportedReasoningEfforts.map((item)=>item.reasoningEffort);
      if(!efforts.includes(reasoningLevel)) return reject("incompatible_setting",keys.effort,`model supports: ${efforts.join(", ")}`);
      return store(providerId,modelId,reasoningLevel);
    },
    save_specialist_selection: async ({projectId,sectionId,providerId,model:modelId,reasoningLevel,serviceTier,expectedVersions})=>{
      const reject=(code:"invalid_choice"|"incompatible_setting"|"catalog_unavailable",key:string,message:string)=>({ok:false,conflict:false,values:{},versions:{},validation:{code,key,params:[key,message]}});
      const catalogHost=await services.selectionCatalogHost(projectId);
      if(!catalogHost.ok) return {ok:false,conflict:false,values:{},versions:{},validation:catalogHost.validation};
      let providers:Awaited<ReturnType<typeof bb.sdk.providers.list>>,catalog:Awaited<ReturnType<typeof bb.sdk.providers.models>>;
      try {[providers,catalog]=await Promise.all([bb.sdk.providers.list({hostId:catalogHost.hostId}),bb.sdk.providers.models({providerId,hostId:catalogHost.hostId})]);}
      catch {return reject("catalog_unavailable","specialist.provider",catalogHost.hostId);}
      const provider=providers.find((item)=>item.id===providerId&&item.available);
      if(!provider) return reject("invalid_choice","specialist.provider",`provider ${providerId} is unavailable on this host`);
      const selectedModel=catalog.models.find((item)=>item.id===modelId||item.model===modelId);
      if(!selectedModel) return reject("invalid_choice","specialist.model",`model ${modelId} is not in the live catalog for ${providerId}`);
      const efforts=selectedModel.supportedReasoningEfforts.map((item)=>item.reasoningEffort);
      if(!efforts.includes(reasoningLevel)) return reject("incompatible_setting","specialist.reasoning_effort",`model supports: ${efforts.join(", ")}`);
      const tiers=provider.serviceTiers?.map((tier)=>tier.id)??[];
      const selectedTier=serviceTier??(provider.capabilities.supportsServiceTier&&tiers.includes("default")?"default":null);
      if(selectedTier&&!tiers.includes(selectedTier)) return reject("invalid_choice","specialist.service_tier",`provider supports: ${tiers.join(", ")||"no service tiers"}`);
      return casUpsertSettings(db,{projectId,bindingId:sectionId?sectionBindingId(sectionId):"",changes:[
        {key:"specialist.provider",value:providerId,expectedVersion:expectedVersions["specialist.provider"]},
        {key:"specialist.model",value:modelId,expectedVersion:expectedVersions["specialist.model"]},
        {key:"specialist.reasoning_effort",value:reasoningLevel,expectedVersion:expectedVersions["specialist.reasoning_effort"]},
        {key:"specialist.service_tier",value:selectedTier==="fast"?"fast":"standard",expectedVersion:expectedVersions["specialist.service_tier"]},
      ]},{nativeWriterSelection:true});
    },
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "save_council_seat_selection" | "save_writer_fallback_selection" | "save_writer_selection" | "save_memory_selection" | "save_night_review_selection" | "save_docs_selection" | "save_project_life_selection" | "save_pm_read_selection" | "save_onboarding_selection" | "save_plan_critique_selection" | "save_code_critique_selection" | "save_specialist_selection">;
}
